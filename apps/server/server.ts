import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ReactAgent,
  RunManager,
  ToolRegistry,
  createAskUserTool,
  createReadFileTool,
  createSearchTool,
} from '../../packages/agent-runtime/src/index.js';
import type { Session, Run } from '../../packages/protocol/src/index.js';

const envPath = join(new URL('../..', import.meta.url).pathname, '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const port = Number(process.env.PORT || 4010);
const sessions = new Map<string, Session>();
const runs = new Map<string, Run>();
const workspace = new URL('../..', import.meta.url).pathname;
const toolRegistry = new ToolRegistry()
  .register(createSearchTool())
  .register(createReadFileTool())
  .register(createAskUserTool());
const agent = new ReactAgent();
const runManager = new RunManager({
  sessions,
  runs,
  agent,
  toolRegistry,
  workspace,
});

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {} as Record<string, unknown>;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
}

function route(method: string, pathname: string) {
  return {
    method,
    parts: pathname.split('/').filter(Boolean),
  };
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

const server = http.createServer(async (req, res) => {
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

    if (method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'approve') {
      const run = runs.get(parts[2]);
      if (!run) {
        return json(res, 404, {
          error: { code: 'RUN_NOT_FOUND', message: 'Run not found' },
        });
      }

      await readJson(req);
      return json(res, 200, {
        run_id: run.id,
        approval_id: null,
        status: 'accepted',
      });
    }

    if (method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'cancel') {
      const run = runs.get(parts[2]);
      if (!run) {
        return json(res, 404, {
          error: { code: 'RUN_NOT_FOUND', message: 'Run not found' },
        });
      }

      runManager.cancel(run.id);
      return json(res, 200, {
        run_id: run.id,
        status: 'cancelled',
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
});

server.listen(port, () => {
  console.log(`Agent Server listening on http://127.0.0.1:${port}`);
});
