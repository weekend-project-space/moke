import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentEvent, RunSnapshot } from '@moke/protocol';
import { MokeClient } from './client.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function event(overrides: Partial<AgentEvent> & Pick<AgentEvent, 'seq' | 'type' | 'payload'>): AgentEvent {
  return {
    id: `evt_${overrides.seq}`,
    run_id: 'run_1',
    session_id: 'sess_1',
    ts: '2026-07-21T00:00:00.000Z',
    ...overrides,
  } as AgentEvent;
}

function sse(events: AgentEvent[]) {
  const text = events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join('');
  const midpoint = Math.floor(text.length / 2);
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, midpoint)));
      controller.enqueue(encoder.encode(text.slice(midpoint)));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('SessionHandle.send maps the message request and returns a RunHandle', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return json({ run_id: 'run_1', session_id: 'sess_1', events_url: '/api/runs/run_1/events' });
  }) as typeof fetch;
  const client = new MokeClient({ baseUrl: 'http://127.0.0.1:4010/', token: 'secret', fetch: fetcher });

  const run = await client.session('sess_1').send({ content: 'hello', reasoningEffort: 'high' });

  assert.equal(run.id, 'run_1');
  assert.equal(run.sessionId, 'sess_1');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4010/api/sessions/sess_1/messages');
  assert.equal(new Headers(calls[0]?.init?.headers).get('Authorization'), 'Bearer secret');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    message: { role: 'user', content: 'hello' },
    options: { stream: true, reasoningEffort: 'high' },
  });
});

test('RunHandle.events parses split SSE data and removes replayed sequences', async () => {
  const events = [
    event({ seq: 1, type: 'agent.started', payload: { input: 'hello' } }),
    event({ seq: 1, type: 'agent.started', payload: { input: 'hello' } }),
    event({
      seq: 2,
      type: 'agent.done',
      payload: { status: 'completed', usage: { steps: 1, tool_calls: 0, duration_ms: 4 } },
    }),
  ];
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async () => sse(events)) as typeof fetch,
  });

  const received: AgentEvent[] = [];
  for await (const item of client.run('run_1').events()) received.push(item);

  assert.deepEqual(received.map((item) => item.seq), [1, 2]);
});

test('RunHandle.events stops when replay ends after an already consumed terminal event', async () => {
  const done = event({ seq: 2, type: 'agent.done', payload: { status: 'completed' } });
  let requests = 0;
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async (input: URL | RequestInfo) => {
      requests += 1;
      return String(input).endsWith('/events')
        ? sse([done])
        : json({ run: { id: 'run_1', session_id: 'sess_1', status: 'completed', seq: 2, events: [done] } });
    }) as typeof fetch,
  });

  const received: AgentEvent[] = [];
  for await (const item of client.run('run_1').events({ afterSeq: 2 })) received.push(item);

  assert.deepEqual(received, []);
  assert.equal(requests, 2);
});

test('RunHandle.result reads a completed run snapshot', async () => {
  const done = event({
    seq: 2,
    type: 'agent.done',
    payload: { status: 'completed', usage: { steps: 2, tool_calls: 1, duration_ms: 8 } },
  });
  const message = event({
    seq: 1,
    type: 'agent.message.done',
    payload: {
      message: { id: 'msg_1', role: 'assistant', content: 'done', created_at: '2026-07-21T00:00:00.000Z' },
    },
  });
  const run: RunSnapshot = {
    id: 'run_1', session_id: 'sess_1', status: 'completed', seq: 2, events: [message, done],
  };
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async () => json({ run })) as typeof fetch,
  });

  const result = await client.run('run_1').result();

  assert.equal(result.status, 'completed');
  assert.equal(result.message?.content, 'done');
  assert.deepEqual(result.usage, { steps: 2, toolCalls: 1, durationMs: 8 });
});

test('withHandlers creates an immutable session policy and prompt overrides bound handlers', async () => {
  const approval = event({
    seq: 1,
    type: 'approval.required',
    payload: {
      approval_id: 'apv_1',
      call_id: 'call_1',
      kind: 'tool',
      reason: 'Allow write?',
      risk: 'write',
      action: { tool: 'write_file', input: { path: 'README.md' } },
      created_at: '2026-07-21T00:00:00.000Z',
    },
  });
  const done = event({ seq: 2, type: 'agent.done', payload: { status: 'completed' } });
  const snapshot: RunSnapshot = {
    id: 'run_1', session_id: 'sess_1', status: 'completed', seq: 2, events: [approval, done],
  };
  const responses: unknown[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/messages')) {
      return json({ run_id: 'run_1', session_id: 'sess_1', events_url: '/api/runs/run_1/events' });
    }
    if (url.endsWith('/events')) return sse([approval, done]);
    if (url.endsWith('/respond')) {
      responses.push(JSON.parse(String(init?.body)));
      return json({ run_id: 'run_1', request_id: 'apv_1', status: 'running' });
    }
    return json({ run: snapshot });
  }) as typeof fetch;
  const client = new MokeClient({ baseUrl: '', fetch: fetcher });
  const session = client.session('sess_1');
  const interactive = session.withHandlers({
    async onApproval() {
      return { decision: 'approved' };
    },
  });
  let contextIds: string[] = [];

  const result = await interactive.prompt(
    { content: 'update the readme' },
    {
      handlers: {
        async onApproval(_request, context) {
          contextIds = [context.session.id, context.run.id];
          return { decision: 'rejected', scope: 'once', message: 'Not now' };
        },
      },
    },
  );

  assert.notEqual(interactive, session);
  assert.equal(result.status, 'completed');
  assert.deepEqual(contextIds, ['sess_1', 'run_1']);
  assert.deepEqual(responses, [{
    type: 'approve',
    request_id: 'apv_1',
    decision: 'rejected',
    scope: 'once',
    message: 'Not now',
  }]);
});
