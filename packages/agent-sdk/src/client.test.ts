import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentEvent, AgentEventInput } from '@moke/agent-protocol';
import type { RunSnapshot } from '@moke/protocol';
import { MokeClient } from './client.js';
import { MokeNetworkError, MokeProtocolError } from './errors.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function event(input: AgentEventInput, sequence: number, runId = 'run_1'): AgentEvent {
  return {
    ...input,
    eventId: `evt_${runId}_${sequence}`,
    sequence,
    runId,
    threadId: 'sess_1',
    timestamp: Date.parse('2026-07-21T00:00:00.000Z'),
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

function lifecycleSse(events: Array<{ type: string; sessionId: string; runId: string }>) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('health invokes fetch with the global context required by browser implementations', async () => {
  const fetcher = async function (this: unknown, input: URL | RequestInfo) {
    assert.equal(this, globalThis);
    assert.equal(String(input), 'http://127.0.0.1:4010/api/health');
    return json({ status: 'ok' });
  } as typeof fetch;
  const client = new MokeClient({ baseUrl: 'http://127.0.0.1:4010', fetch: fetcher });

  assert.deepEqual(await client.health(), { status: 'ok' });
});

test('sessions.create sends the creation-only workspace environment', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return json({ session: { id: 'sess_1' } });
  }) as typeof fetch;
  const client = new MokeClient({ baseUrl: 'http://127.0.0.1:4010', fetch: fetcher });

  const session = await client.sessions.create({
    title: 'Project A',
    env: {
      approval_mode: 'read-only',
      workspace: { root: 'E:\\work\\project-a' },
    },
  });

  assert.equal(session.id, 'sess_1');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    title: 'Project A',
    env: {
      approval_mode: 'read-only',
      workspace: { root: 'E:\\work\\project-a' },
    },
  });
});

test('sessions.create sends visibility and session model environment', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return json({ session: { id: 'sess_hidden' } });
  }) as typeof fetch;
  const client = new MokeClient({ baseUrl: 'http://127.0.0.1:4010', fetch: fetcher });

  await client.sessions.create({
    title: 'Background task',
    visibility: 'hidden',
    env: { model: { provider_id: 'provider_openai', name: 'gpt-5' } },
  });

  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    title: 'Background task',
    visibility: 'hidden',
    env: { model: { provider_id: 'provider_openai', name: 'gpt-5' } },
  });
});

test('SessionHandle.send maps the message request and returns a RunHandle', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return json({ run_id: 'run_1', session_id: 'sess_1', events_url: '/api/runs/run_1/events' });
  }) as typeof fetch;
  const client = new MokeClient({ baseUrl: 'http://127.0.0.1:4010/', token: 'secret', fetch: fetcher });

  const run = await client.session('sess_1').send({
    content: 'hello',
    files: [{ name: 'report.pdf', path: 'E:\\reports\\report.pdf' }],
    env: {
      approval_mode: 'workspace-write',
      model: { provider_id: 'provider_openai', name: 'gpt-5' },
      reasoningEffort: 'high',
    },
  });

  assert.equal(run.id, 'run_1');
  assert.equal(run.sessionId, 'sess_1');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4010/api/sessions/sess_1/messages');
  assert.equal(new Headers(calls[0]?.init?.headers).get('Authorization'), 'Bearer secret');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    message: {
      role: 'user',
      content: 'hello',
      files: [{ name: 'report.pdf', path: 'E:\\reports\\report.pdf' }],
    },
    env: {
      approval_mode: 'workspace-write',
      model: { provider_id: 'provider_openai', name: 'gpt-5' },
      reasoningEffort: 'high',
    },
    options: { stream: true },
  });
});

test('sessions.list supports includeHidden without dropping includeArchived', async () => {
  let requestUrl = '';
  const client = new MokeClient({
    baseUrl: 'http://127.0.0.1:4010',
    fetch: (async (input: URL | RequestInfo) => {
      requestUrl = String(input);
      return json({ sessions: [], next_cursor: null });
    }) as typeof fetch,
  });

  await client.sessions.list({ includeArchived: true, includeHidden: true });
  assert.equal(requestUrl, 'http://127.0.0.1:4010/api/sessions?include_archived=true&include_hidden=true');
});

test('SessionHandle.get preserves session metadata returned by the detail endpoint', async () => {
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async () => json({
      session: {
        id: 'sess_1', title: 'Test', created_at: '', updated_at: '', archived: false,
        pinned: false, preview: '', message_count: 0, metadata: { workspace: 'E:/work/example' },
      },
      messages: [],
    })) as typeof fetch,
  });

  const session = await client.session('sess_1').get();

  assert.deepEqual(session.metadata, { workspace: 'E:/work/example' });
});

test('SessionHandle.get rejects a detail response without metadata', async () => {
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async () => json({ session: { id: 'sess_1' }, messages: [] })) as typeof fetch,
  });

  await assert.rejects(client.session('sess_1').get(), MokeProtocolError);
});

test('RunHandle.events parses split SSE data and removes replayed sequences', async () => {
  const events = [
    event({ type: 'run.started' }, 1),
    event({ type: 'run.started' }, 1),
    event({ type: 'run.completed', usage: { steps: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0 } }, 2),
  ];
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async () => sse(events)) as typeof fetch,
  });

  const received: AgentEvent[] = [];
  for await (const item of client.run('run_1').events()) received.push(item);

  assert.deepEqual(received.map((item) => item.sequence), [1, 2]);
});

test('RunHandle.events stops when replay ends after an already consumed terminal event', async () => {
  const done = event({ type: 'run.completed' }, 2);
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

test('RunHandle.events resumes with Last-Event-ID after a disconnected stream', async () => {
  const state = event({ type: 'state.snapshot', snapshot: { phase: 'reason' } }, 1);
  const done = event({ type: 'run.completed' }, 2);
  const eventHeaders: Array<string | null> = [];
  let eventRequests = 0;
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith('/events')) {
        eventHeaders.push(new Headers(init?.headers).get('Last-Event-ID'));
        eventRequests += 1;
        return eventRequests === 1 ? sse([state]) : sse([done]);
      }
      return json({ run: { id: 'run_1', session_id: 'sess_1', status: 'running', seq: 1, events: [state] } });
    }) as typeof fetch,
  });

  const received: AgentEvent[] = [];
  for await (const item of client.run('run_1').events({ maxReconnectDelayMs: 0 })) received.push(item);

  assert.deepEqual(received.map((item) => item.sequence), [1, 2]);
  assert.deepEqual(eventHeaders, [null, '1']);
});

test('RunHandle.events stops after the configured reconnect limit', async () => {
  let requests = 0;
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async () => {
      requests += 1;
      throw new Error('offline');
    }) as typeof fetch,
  });

  await assert.rejects(
    async () => {
      for await (const _item of client.run('run_1').events({
        maxReconnectAttempts: 2,
        maxReconnectDelayMs: 0,
      })) { /* no events */ }
    },
    MokeNetworkError,
  );
  assert.equal(requests, 3);
});

test('RunHandle.events cancels the response body when the consumer exits early', async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const state = event({ type: 'state.snapshot', snapshot: { phase: 'reason' } }, 1);
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const client = new MokeClient({ baseUrl: '', fetch: (async () => response) as typeof fetch });

  for await (const _item of client.run('run_1').events()) break;

  assert.equal(cancelled, true);
});

test('MokeClient applies the configured user agent when the runtime permits it', async () => {
  let userAgent: string | null = null;
  const client = new MokeClient({
    baseUrl: '',
    userAgent: 'moke-test/1.0',
    fetch: (async (_input: URL | RequestInfo, init?: RequestInit) => {
      userAgent = new Headers(init?.headers).get('User-Agent');
      return json({ status: 'ok' });
    }) as typeof fetch,
  });

  await client.health();
  assert.equal(userAgent, 'moke-test/1.0');
});

test('MokeClient exposes simplified application-wide run lifecycle events', async () => {
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async () => lifecycleSse([
      { type: 'running', sessionId: 'sess_1', runId: 'run_1' },
      { type: 'completed', sessionId: 'sess_1', runId: 'run_1' },
    ])) as typeof fetch,
  });
  const received: Array<{ type: string; sessionId: string; runId: string }> = [];
  let off = () => undefined;
  const completed = new Promise<void>((resolve) => {
    off = client.onRunLifecycle((event) => {
      received.push(event);
      if (event.type === 'completed') resolve();
    });
  });

  await completed;
  off();

  assert.deepEqual(received, [
    { type: 'running', sessionId: 'sess_1', runId: 'run_1' },
    { type: 'completed', sessionId: 'sess_1', runId: 'run_1' },
  ]);
});

test('MokeClient shares lifecycle transport and replays current runs to new listeners', async () => {
  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let transportSignal: AbortSignal | undefined;
  let requests = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async (_input: URL | RequestInfo, init?: RequestInit) => {
      requests += 1;
      transportSignal = init?.signal || undefined;
      return response;
    }) as typeof fetch,
  });
  let firstReceived!: () => void;
  const firstEvent = new Promise<void>((resolve) => { firstReceived = resolve; });
  const first: string[] = [];
  const offFirst = client.onRunLifecycle((event) => {
    first.push(event.type);
    firstReceived();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  streamController.enqueue(encoder.encode('data: {"type":"running","sessionId":"sess_1","runId":"run_1"}\n\n'));
  await firstEvent;

  const second: string[] = [];
  const offSecond = client.onRunLifecycle((event) => second.push(event.type));

  assert.equal(requests, 1);
  assert.deepEqual(first, ['running']);
  assert.deepEqual(second, ['running']);
  offFirst();
  assert.equal(transportSignal?.aborted, false);
  offSecond();
  assert.equal(transportSignal?.aborted, true);
  streamController.close();
});

test('SessionHandle.onRunEvent follows the session active run and provides its handle', async () => {
  const encoder = new TextEncoder();
  let lifecycleController!: ReadableStreamDefaultController<Uint8Array>;
  let eventsController!: ReadableStreamDefaultController<Uint8Array>;
  const lifecycleResponse = new Response(new ReadableStream<Uint8Array>({
    start(controller) { lifecycleController = controller; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const eventsResponse = new Response(new ReadableStream<Uint8Array>({
    start(controller) { eventsController = controller; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async (input: URL | RequestInfo) => String(input).endsWith('/lifecycle')
      ? lifecycleResponse
      : eventsResponse) as typeof fetch,
  });
  const received: Array<{ event: AgentEvent; runId: string; sessionId?: string }> = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const stop = client.session('sess_1').onRunEvent((item, run) => {
    received.push({ event: item, runId: run.id, sessionId: run.sessionId });
    if (item.type === 'run.completed') resolveDone();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  lifecycleController.enqueue(encoder.encode(
    'data: {"type":"running","sessionId":"sess_1","runId":"run_1"}\n\n',
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const delta = event({ type: 'message.content', messageId: 'msg_1', delta: 'hello' }, 1);
  const finished = event({ type: 'run.completed' }, 2);
  eventsController.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
  lifecycleController.enqueue(encoder.encode(
    'data: {"type":"completed","sessionId":"sess_1","runId":"run_1"}\n\n',
  ));
  eventsController.enqueue(encoder.encode(`data: ${JSON.stringify(finished)}\n\n`));
  eventsController.close();

  await done;
  stop();
  lifecycleController.close();

  assert.deepEqual(received.map(({ event: item }) => item.type), ['message.content', 'run.completed']);
  assert.deepEqual(received.map(({ runId }) => runId), ['run_1', 'run_1']);
  assert.deepEqual(received.map(({ sessionId }) => sessionId), ['sess_1', 'sess_1']);
});

test('SessionHandle.onRunEvent ignores other sessions and stops future delivery', async () => {
  const encoder = new TextEncoder();
  let lifecycleController!: ReadableStreamDefaultController<Uint8Array>;
  let eventRequests = 0;
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async (input: URL | RequestInfo) => {
      if (String(input).endsWith('/lifecycle')) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { lifecycleController = controller; },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      eventRequests += 1;
      return lifecycleSse([]);
    }) as typeof fetch,
  });
  const received: AgentEvent[] = [];
  const stop = client.session('sess_1').onRunEvent((item) => received.push(item));
  await new Promise<void>((resolve) => setImmediate(resolve));

  lifecycleController.enqueue(encoder.encode(
    'data: {"type":"running","sessionId":"sess_2","runId":"run_2"}\n\n',
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  stop();

  assert.equal(eventRequests, 0);
  assert.deepEqual(received, []);
  assert.doesNotThrow(stop);
});

test('SessionHandle.onRunEvent follows subsequent runs without resubscribing', async () => {
  const encoder = new TextEncoder();
  let lifecycleController!: ReadableStreamDefaultController<Uint8Array>;
  const eventControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async (input: URL | RequestInfo) => {
      if (String(input).endsWith('/lifecycle')) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { lifecycleController = controller; },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { eventControllers.push(controller); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch,
  });
  const received: string[] = [];
  let resolveBoth!: () => void;
  const bothRuns = new Promise<void>((resolve) => { resolveBoth = resolve; });
  const stop = client.session('sess_1').onRunEvent((item, run) => {
    received.push(`${run.id}:${item.type}`);
    if (received.length === 2) resolveBoth();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  lifecycleController.enqueue(encoder.encode(
    'data: {"type":"running","sessionId":"sess_1","runId":"run_1"}\n\n',
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  eventControllers[0].enqueue(encoder.encode(`data: ${JSON.stringify(
    event({ type: 'run.completed' }, 1),
  )}\n\n`));
  eventControllers[0].close();
  lifecycleController.enqueue(encoder.encode(
    'data: {"type":"completed","sessionId":"sess_1","runId":"run_1"}\n\n',
  ));
  lifecycleController.enqueue(encoder.encode(
    'data: {"type":"running","sessionId":"sess_1","runId":"run_2"}\n\n',
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  eventControllers[1].enqueue(encoder.encode(`data: ${JSON.stringify({
    ...event({ type: 'run.completed' }, 1, 'run_2'),
  })}\n\n`));
  eventControllers[1].close();

  await bothRuns;
  stop();
  lifecycleController.close();

  assert.deepEqual(received, ['run_1:run.completed', 'run_2:run.completed']);
});

test('RunHandle.result reads a completed run snapshot', async () => {
  const done = event({ type: 'run.completed', usage: { steps: 2, toolCalls: 1, inputTokens: 100, outputTokens: 20, cachedInputTokens: 75 } }, 2);
  const message = event({ type: 'message.completed', messageId: 'msg_1', message: { id: 'msg_1', role: 'assistant', content: 'done' } }, 1);
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
  assert.deepEqual(result.usage, {
    steps: 2,
    toolCalls: 1,
    durationMs: 0,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 75,
  });
});

test('workspace.createContext creates a temporary draft workspace context', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new MokeClient({
    baseUrl: 'http://127.0.0.1:4010',
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json({ id: 'ctx_1', root: 'E:\\work\\project-a', expires_at: '2026-08-08T00:10:00.000Z' });
    }) as typeof fetch,
  });

  const context = await client.workspace.createContext({
    workspaceRoot: 'E:\\work\\project-a',
    ttlMs: 600_000,
  });

  assert.deepEqual(context, {
    id: 'ctx_1', root: 'E:\\work\\project-a', expiresAt: '2026-08-08T00:10:00.000Z',
  });
  assert.equal(calls[0]?.url, 'http://127.0.0.1:4010/api/workspace/contexts');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    root: 'E:\\work\\project-a', ttl_ms: 600_000,
  });
});

test('session.workspace.entries returns simple name and path records', async () => {
  let requestUrl = '';
  const client = new MokeClient({
    baseUrl: 'http://127.0.0.1:4010',
    fetch: (async (input: URL | RequestInfo) => {
      requestUrl = String(input);
      return json([
        { name: 'src', path: 'src', kind: 'directory' },
        { name: 'README.md', path: 'README.md', kind: 'file', size: 42 },
      ]);
    }) as typeof fetch,
  });

  const entries = await client.session('sess_1').workspace.entries({ query: 'read', limit: 20 });

  assert.equal(requestUrl, 'http://127.0.0.1:4010/api/workspace/entries?session_id=sess_1&query=read&limit=20');
  assert.deepEqual(entries, [
    { name: 'src', path: 'src' },
    { name: 'README.md', path: 'README.md' },
  ]);
});

test('session.skills.list returns simple name and description records', async () => {
  let requestUrl = '';
  const client = new MokeClient({
    baseUrl: 'http://127.0.0.1:4010',
    fetch: (async (input: URL | RequestInfo) => {
      requestUrl = String(input);
      return json([{ name: 'research', description: 'Research across sources', enabled: true }]);
    }) as typeof fetch,
  });

  const skills = await client.session('sess_1').skills.list({ enabledOnly: true });

  assert.equal(requestUrl, 'http://127.0.0.1:4010/api/workspace/skills?session_id=sess_1&enabled_only=true');
  assert.deepEqual(skills, [{ name: 'research', description: 'Research across sources' }]);
});

test('models.list groups simple model records by provider', async () => {
  let requestUrl = '';
  const client = new MokeClient({
    baseUrl: 'http://127.0.0.1:4010',
    fetch: (async (input: URL | RequestInfo) => {
      requestUrl = String(input);
      return json([{
        provider: 'provider_local',
        provider_name: 'Local',
        models: [
          { name: 'reasoning-model', supports_reasoning: true },
          { name: 'chat-model' },
        ],
      }]);
    }) as typeof fetch,
  });

  const providers = await client.models.list({ providerId: 'provider_1', refresh: true });

  assert.equal(requestUrl, 'http://127.0.0.1:4010/api/settings/model/capabilities?provider_id=provider_1&refresh=true');
  assert.deepEqual(providers, [{
    provider: 'provider_local',
    providerName: 'Local',
    models: [
      { name: 'reasoning-model', supportsReasoning: true },
      { name: 'chat-model' },
    ],
  }]);
});

test('resource methods reject malformed response records', async () => {
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async () => json([{ name: 'missing path' }])) as typeof fetch,
  });

  await assert.rejects(client.workspace.entries({ contextId: 'ctx_1' }), MokeProtocolError);
});

test('RunHandle sends custom ask answers', async () => {
  const requests: unknown[] = [];
  const client = new MokeClient({
    baseUrl: '',
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith('/respond')) {
        requests.push(JSON.parse(String(init?.body)));
        return json({ run_id: 'run_1', request_id: 'ask_1', status: 'running' });
      }
      return json({ run: { id: 'run_1', session_id: 'sess_1', status: 'running', seq: 0, events: [] } });
    }) as typeof fetch,
  });

  await client.run('run_1').answer({ requestId: 'ask_1', customText: 'Another answer' });

  assert.deepEqual(requests, [{ type: 'choose', request_id: 'ask_1', custom_text: 'Another answer' }]);
});

test('withHandlers creates an immutable session policy and chat overrides bound handlers', async () => {
  const approval = event({ type: 'interaction.required', interaction: { id: 'apv_1', type: 'approval', toolCallId: 'call_1', approvalKind: 'tool', reason: 'Allow write?', action: { tool: 'write_file', input: { path: 'README.md' } } } }, 1);
  const done = event({ type: 'run.completed' }, 2);
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

  const result = await interactive.chat(
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
