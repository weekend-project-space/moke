import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Run, Session } from '../../packages/protocol/src/index.js';
import type { RunManager, ToolRegistry } from '../../packages/agent-runtime/src/index.js';
import type { BrowserBridge } from './browser-bridge.js';
import { json, readJson, route } from './http.js';

type RoutesContext = {
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  runManager: RunManager;
  toolRegistry: ToolRegistry;
  browserBridge: BrowserBridge;
  onChange: () => void;
};

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function isTerminalRun(run: Run) {
  return ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status);
}

function summarizeSession(session: Session) {
  const { messages, metadata, ...summary } = session;
  return {
    ...summary,
    preview: messages.find((message) => message.role === 'user')?.content.slice(0, 42) || session.title,
    message_count: messages.length,
  };
}

export function createRoutes({ sessions, runs, runManager, toolRegistry, browserBridge, onChange }: RoutesContext) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {});

      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const { method, parts } = route(req.method || 'GET', url.pathname);

      if (method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          status: 'ok',
          service: 'moke-agent-server',
          ts: now(),
        });
      }

      if (method === 'GET' && url.pathname === '/api/tools') {
        return json(res, 200, {
          tools: toolRegistry.list().map(({ schema, ...tool }) => tool),
        });
      }

      if (method === 'GET' && url.pathname === '/api/browser/connect') {
        browserBridge.connect(res);
        req.on('close', () => browserBridge.disconnect(res));
        return;
      }

      if (method === 'POST' && url.pathname === '/api/browser/respond') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) {
          return json(res, 400, {
            error: { code: 'BAD_REQUEST', message: 'id is required' },
          });
        }

        const accepted = browserBridge.respond(id, {
          ok: body.ok !== false,
          result: typeof body.result === 'object' && body.result !== null ? body.result : {},
          error: typeof body.error === 'string' ? body.error : undefined,
        });

        return json(res, accepted ? 200 : 404, {
          accepted,
        });
      }

      if (method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readJson(req);
        const session: Session = {
          id: id('sess'),
          title: typeof body.title === 'string' ? body.title : 'New Session',
          created_at: now(),
          updated_at: now(),
          messages: [],
          metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : {},
        };
        sessions.set(session.id, session);
        onChange();
        return json(res, 200, { session });
      }

      if (method === 'GET' && url.pathname === '/api/sessions') {
        return json(res, 200, {
          sessions: [...sessions.values()].map(summarizeSession),
          next_cursor: null,
        });
      }

      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3) {
        const session = sessions.get(parts[2]);
        if (!session) {
          return json(res, 404, {
            error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
          });
        }

        return json(res, 200, { session: summarizeSession(session), messages: session.messages });
      }

      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
        const session = sessions.get(parts[2]);
        if (!session) {
          return json(res, 404, {
            error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
          });
        }

        const body = await readJson(req);
        const message = body.message && typeof body.message === 'object' ? body.message : {};
        const content = typeof message.content === 'string' ? message.content.trim() : '';
        if (!content) {
          return json(res, 400, {
            error: { code: 'BAD_REQUEST', message: 'message.content is required' },
          });
        }

        session.messages.push({
          id: id('msg'),
          role: 'user',
          content,
          created_at: now(),
        });
        session.updated_at = now();

        const options = body.options && typeof body.options === 'object' ? body.options : {};
        const run = runManager.createRun(session, content, options);

        return json(res, 200, {
          run_id: run.id,
          session_id: session.id,
          events_url: `/api/runs/${run.id}/events`,
        });
      }

      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'events') {
        const run = runs.get(parts[2]);
        if (!run) {
          return json(res, 404, {
            error: { code: 'RUN_NOT_FOUND', message: 'Run not found' },
          });
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        for (const event of run.events) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }

        if (isTerminalRun(run)) {
          res.end();
          return;
        }

        run.clients.add(res);
        req.on('close', () => run.clients.delete(res));
        return;
      }

      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'respond') {
        const run = runs.get(parts[2]);
        if (!run) {
          return json(res, 404, {
            error: { code: 'RUN_NOT_FOUND', message: 'Run not found' },
          });
        }

        const body = await readJson(req);
        const type = typeof body.type === 'string' ? body.type : '';

        if (type === 'choose') {
          const requestId = typeof body.request_id === 'string' ? body.request_id : '';
          const optionId = typeof body.option_id === 'string' ? body.option_id : '';

          if (!requestId || !optionId) {
            return json(res, 400, {
              error: { code: 'BAD_REQUEST', message: 'request_id and option_id are required' },
            });
          }

          const result = runManager.answer(run.id, requestId, optionId);
          if (result.status !== 200) {
            return json(res, result.status, {
              error: {
                code: result.status === 404 ? 'RUN_NOT_FOUND' : result.status === 400 ? 'BAD_REQUEST' : 'ASK_NOT_PENDING',
                message: result.error,
              },
            });
          }

          return json(res, 200, {
            run_id: result.run.id,
            request_id: requestId,
            status: result.run.status,
          });
        }

        if (type === 'approve') {
          return json(res, 200, {
            run_id: run.id,
            request_id: typeof body.request_id === 'string' ? body.request_id : null,
            status: 'accepted',
          });
        }

        if (type === 'cancel') {
          runManager.cancel(run.id);
          return json(res, 200, {
            run_id: run.id,
            status: 'cancelled',
          });
        }

        return json(res, 400, {
          error: { code: 'BAD_REQUEST', message: 'type must be choose, approve, or cancel' },
        });
      }

      return json(res, 404, {
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      });
    } catch (error) {
      return json(res, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  };
}
