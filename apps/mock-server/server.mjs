import http from 'node:http';
import {
  randomUUID
} from 'node:crypto';

const port = Number(process.env.PORT || 4010);
const sessions = new Map();
const runs = new Map();
const clients = new Map();

function id(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function emit(runId, type, payload) {
  const run = runs.get(runId);
  if (!run) return;

  const event = {
    id: id('evt'),
    seq: ++run.seq,
    type,
    run_id: run.id,
    session_id: run.session_id,
    ts: now(),
    payload,
  };

  run.events.push(event);
  const sse = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of clients.get(runId) || []) res.write(sse);
}

function completeRun(runId) {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return;

  emit(runId, 'agent.message.delta', {
    content: 'Mock review complete. The runtime and client event flow are connected.',
  });
  emit(runId, 'agent.message.done', {
    message: {
      id: id('msg'),
      role: 'assistant',
      content: 'Mock review complete. The runtime and client event flow are connected.',
      created_at: now(),
    },
  });
  run.status = 'completed';
  emit(runId, 'agent.done', {
    status: 'completed',
    usage: {
      steps: 4,
      tool_calls: 2,
      duration_ms: Date.now() - run.started_at,
    },
  });
}

function scheduleMockRun(runId, input) {
  const timers = [
    [250, () => emit(runId, 'agent.started', {
      input
    })],
    [700, () => emit(runId, 'agent.plan', {
      intent: 'project_assist',
      risk: 'safe',
      steps: ['Understand the request', 'Inspect project context', 'Summarize next action'],
      tools: ['search', 'read_file'],
    })],
    [1100, () => emit(runId, 'agent.state', {
      state: 'act'
    })],
    [1500, () => emit(runId, 'tool.call', {
      call_id: 'call_search_01',
      tool: 'search',
      input: {
        query: 'docs/*.md'
      },
      risk: 'safe',
    })],
    [2100, () => emit(runId, 'tool.result', {
      call_id: 'call_search_01',
      status: 'ok',
      duration_ms: 38,
      output: {
        matches: ['docs/agent-api.md', 'docs/requirements.md']
      },
    })],
    [2600, () => emit(runId, 'agent.message.delta', {
      content: 'I found the current API and requirements documents. ',
    })],
    [3300, () => emit(runId, 'approval.required', {
      approval_id: 'apv_write_01',
      reason: 'Agent wants to continue with a mocked write action.',
      risk: 'write',
      action: {
        tool: 'write_file',
        input: {
          path: 'mock-output.txt'
        },
      },
    })],
  ];

  const run = runs.get(runId);
  for (const [delay, fn] of timers) {
    run.timers.push(setTimeout(() => {
      if (run.status === 'running') fn();
    }, delay));
  }
}

function route(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  return {
    method,
    parts
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {});

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const {
      method,
      parts
    } = route(req.method || 'GET', url.pathname);

    if (method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        status: 'ok',
        service: 'moke-mock-agent',
        ts: now(),
      });
    }

    if (method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readJson(req);
      const session = {
        id: id('sess'),
        title: body.title || 'New Session',
        created_at: now(),
        updated_at: now(),
        messages: [],
        metadata: body.metadata || {},
      };
      sessions.set(session.id, session);
      return json(res, 200, {
        session
      });
    }

    if (method === 'GET' && url.pathname === '/api/sessions') {
      return json(res, 200, {
        sessions: [...sessions.values()].map(({
          messages,
          metadata,
          ...session
        }) => session),
        next_cursor: null,
      });
    }

    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 3) {
      const session = sessions.get(parts[2]);
      if (!session) return json(res, 404, {
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found'
        }
      });
      const {
        messages,
        metadata,
        ...summary
      } = session;
      return json(res, 200, {
        session: summary,
        messages
      });
    }

    if (method === 'POST' && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
      const session = sessions.get(parts[2]);
      if (!session) return json(res, 404, {
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Session not found'
        }
      });

      const body = await readJson(req);
      const content = body.message?.content?.trim();
      if (!content) return json(res, 400, {
        error: {
          code: 'BAD_REQUEST',
          message: 'message.content is required'
        }
      });

      session.messages.push({
        id: id('msg'),
        role: 'user',
        content,
        created_at: now()
      });
      session.updated_at = now();

      const run = {
        id: id('run'),
        session_id: session.id,
        status: 'running',
        seq: 0,
        events: [],
        timers: [],
        started_at: Date.now(),
      };
      runs.set(run.id, run);
      scheduleMockRun(run.id, content);

      return json(res, 200, {
        run_id: run.id,
        session_id: session.id,
        events_url: `/api/runs/${run.id}/events`,
      });
    }

    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'events') {
      const run = runs.get(parts[2]);
      if (!run) return json(res, 404, {
        error: {
          code: 'RUN_NOT_FOUND',
          message: 'Run not found'
        }
      });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      for (const event of run.events) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }

      if (!clients.has(run.id)) clients.set(run.id, new Set());
      clients.get(run.id).add(res);
      req.on('close', () => clients.get(run.id)?.delete(res));
      return;
    }

    if (method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'approve') {
      const run = runs.get(parts[2]);
      if (!run) return json(res, 404, {
        error: {
          code: 'RUN_NOT_FOUND',
          message: 'Run not found'
        }
      });
      const body = await readJson(req);

      emit(run.id, 'tool.result', {
        call_id: 'call_write_01',
        status: body.decision === 'approved' ? 'ok' : 'denied',
        duration_ms: 24,
        output: {
          approval_id: body.approval_id,
          decision: body.decision,
          message: body.message || null,
        },
      });

      if (body.decision === 'approved') {
        completeRun(run.id);
      } else {
        run.status = 'completed';
        emit(run.id, 'agent.done', {
          status: 'completed',
          usage: {
            steps: 3,
            tool_calls: 1,
            duration_ms: Date.now() - run.started_at
          }
        });
      }

      return json(res, 200, {
        run_id: run.id,
        approval_id: body.approval_id,
        status: 'accepted',
      });
    }

    if (method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'cancel') {
      const run = runs.get(parts[2]);
      if (!run) return json(res, 404, {
        error: {
          code: 'RUN_NOT_FOUND',
          message: 'Run not found'
        }
      });
      for (const timer of run.timers) clearTimeout(timer);
      run.status = 'cancelled';
      emit(run.id, 'agent.done', {
        status: 'cancelled',
        usage: {
          steps: run.seq,
          tool_calls: 0,
          duration_ms: Date.now() - run.started_at
        }
      });
      return json(res, 200, {
        run_id: run.id,
        status: 'cancelled'
      });
    }

    return json(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
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
  console.log(`Mock Agent API listening on http://localhost:${port}`);
});
