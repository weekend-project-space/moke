import assert from 'node:assert/strict';
import test from 'node:test';

import type { ImageAttachment, Message, RunLifecycleEvent, Session, ToolApprovalRecord } from '@moke/protocol';
import type { Agent } from './agent.js';
import { RunManager, selectRecentHistory } from './run-manager.js';
import { ToolRegistry } from './tool-registry.js';

function message(input: Partial<Message> & Pick<Message, 'role'>): Message {
  return {
    id: `msg_${Math.random()}`,
    content: '',
    created_at: new Date().toISOString(),
    ...input,
  } as Message;
}

test('selectRecentHistory keeps a complete tool-call group at the cutoff', () => {
  const history: Message[] = [
    message({ role: 'user', content: 'old' }),
    message({ role: 'assistant', tool_calls: [
      { id: 'call_1', name: 'first', args: {} },
      { id: 'call_2', name: 'second', args: {} },
    ] }),
    message({ role: 'tool', tool_call_id: 'call_1', name: 'first' }),
    message({ role: 'tool', tool_call_id: 'call_2', name: 'second' }),
    message({ role: 'assistant', content: 'done' }),
  ];

  const selected = selectRecentHistory(history, 3);

  assert.equal(selected[0]?.role, 'assistant');
  assert.equal(selected.length, 4);
  assert.deepEqual(selected.slice(1, 3).map((item) => item.role), ['tool', 'tool']);
});

test('selectRecentHistory uses the requested tail when it starts at a turn boundary', () => {
  const history: Message[] = [
    message({ role: 'user', content: 'old' }),
    message({ role: 'assistant', content: 'old answer' }),
    message({ role: 'user', content: 'new' }),
    message({ role: 'assistant', content: 'new answer' }),
  ];

  assert.deepEqual(selectRecentHistory(history, 2), history.slice(2));
});

test('RunManager exposes messaging origin to in-process observers', async () => {
  const session = createSession();
  const runs = new Map();
  const agent: Agent = {
    async run() {
      return { toolCalls: 0, message: message({ role: 'assistant', content: 'done' }) };
    },
  };
  const manager = new RunManager({ runs, agent, toolRegistry: new ToolRegistry(), workspace: process.cwd() });
  const observed: string[] = [];
  manager.addObserver((event, run) => {
    if (event.type === 'agent.done') observed.push(run.origin.kind);
  });
  const run = manager.createRun(session, { content: 'start' }, {
    origin: {
      kind: 'messaging',
      platform: 'weixin',
      connection_id: 'wxconn_1',
      binding_id: 'bind_1',
      inbound_message_id: 'message_1',
    },
  });
  await waitFor(() => run.status === 'completed');
  assert.deepEqual(observed, ['messaging']);
});

test('RunManager calls beforeStart before agent execution can emit events', async () => {
  const session = createSession();
  const runs = new Map();
  const agent: Agent = {
    async run() {
      return { toolCalls: 0, message: message({ role: 'assistant', content: 'done' }) };
    },
  };
  const manager = new RunManager({ runs, agent, toolRegistry: new ToolRegistry(), workspace: process.cwd() });
  let attachedRunId = '';
  manager.addObserver((_event, run) => {
    assert.equal(attachedRunId, run.id);
  });

  const run = manager.createRun(session, { content: 'start' }, {
    beforeStart: (createdRun) => { attachedRunId = createdRun.id; },
  });

  await waitFor(() => run.status === 'completed');
});

test('RunManager emits the simplified lifecycle whenever a run status changes', async () => {
  const session = createSession();
  const runs = new Map();
  const agent: Agent = {
    async run(input) {
      const selected = await input.context.askUser?.({
        callId: 'call_1',
        question: 'Continue?',
        options: [{ id: 'yes', label: 'Yes' }],
      });
      return { toolCalls: 1, message: message({ role: 'assistant', content: selected?.label || '' }) };
    },
  };
  const manager = new RunManager({ runs, agent, toolRegistry: new ToolRegistry(), workspace: process.cwd() });
  const observed: RunLifecycleEvent[] = [];
  manager.addLifecycleObserver((event) => observed.push(event));

  const run = manager.createRun(session, { content: 'start' });
  await waitFor(() => run.status === 'awaiting_user');
  manager.answer(run.id, run.pending_ask?.ask_id || '', 'yes');
  await waitFor(() => run.status === 'completed');

  assert.deepEqual(observed, [
    { type: 'running', sessionId: session.id, runId: run.id },
    { type: 'awaiting_user', sessionId: session.id, runId: run.id },
    { type: 'running', sessionId: session.id, runId: run.id },
    { type: 'completed', sessionId: session.id, runId: run.id },
  ]);
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for run state');
}

function createSession(): Session {
  return {
    id: 'session_1',
    title: 'Test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    messages: [],
    metadata: {},
  };
}

test('RunManager records an ask answer as an interaction event instead of chat messages', async () => {
  const session = createSession();
  const runs = new Map();
  const agent: Agent = {
    async run(input) {
      const selected = await input.context.askUser?.({
        callId: 'call_1',
        question: 'Continue?',
        options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      });
      return {
        toolCalls: 1,
        message: message({ role: 'assistant', content: selected?.label || '' }),
      };
    },
  };
  const manager = new RunManager({
    runs,
    agent,
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });

  const run = manager.createRun(session, { content: 'start' });
  await waitFor(() => Boolean(run.pending_ask));
  const askId = run.pending_ask?.ask_id || '';
  assert.equal(manager.answer(run.id, askId, 'yes').status, 200);
  await waitFor(() => run.status === 'completed');

  assert.deepEqual(session.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'assistant', content: 'Yes' },
  ]);
  assert.deepEqual(
    run.events.filter((item) => item.type.startsWith('ask_user.')).map((item) => item.type),
    ['ask_user.required', 'ask_user.answered'],
  );
});

test('RunManager emits approval resolution after a decision', async () => {
  const session = createSession();
  const runs = new Map();
  let recordedApprovals: ToolApprovalRecord[] = [];
  const agent: Agent = {
    async run(input) {
      await input.context.approveTool?.({
        callId: 'call_1',
        tool: 'execute',
        input: { command: 'npm test' },
        risk: 'write',
        reason: 'Run tests',
      });
      recordedApprovals = input.context.consumeApprovals?.('call_1') || [];
      return { toolCalls: 1, message: message({ role: 'assistant', content: 'done' }) };
    },
  };
  const manager = new RunManager({
    runs,
    agent,
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });

  const run = manager.createRun(session, { content: 'start' });
  await waitFor(() => Boolean(run.pending_approval));
  const approvalId = run.pending_approval?.approval_id || '';
  assert.equal(run.pending_approval?.call_id, 'call_1');
  assert.equal(manager.approve(run.id, approvalId, 'approved', { scope: 'once' }).status, 200);
  await waitFor(() => run.status === 'completed');

  const resolved = run.events.find((item) => item.type === 'approval.resolved');
  assert.deepEqual(resolved?.payload, {
    approval_id: approvalId,
    decision: 'approved',
    scope: 'once',
  });
  assert.deepEqual(recordedApprovals, [{
    approval_id: approvalId,
    kind: 'tool',
    decision: 'approved',
    scope: 'once',
    reason: 'Run tests',
  }]);
});

test('RunManager persists a returned final message after intermediate tool messages', async () => {
  const session = createSession();
  const finalMessage = message({ role: 'assistant', content: 'final' });
  const agent: Agent = {
    async run(input) {
      input.eventBus.emit('agent.message.done', {
        message: message({ role: 'tool', content: 'tool output', tool_call_id: 'call_1', name: 'test' }),
      });
      return { toolCalls: 1, message: finalMessage };
    },
  };
  const manager = new RunManager({
    runs: new Map(),
    agent,
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });

  const run = manager.createRun(session, { content: 'start' });
  await waitFor(() => run.status === 'completed');

  assert.deepEqual(session.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'tool', content: 'tool output' },
    { role: 'assistant', content: 'final' },
  ]);
});

test('RunManager shutdown waits for execution and ignores late messages', async () => {
  const session = createSession();
  let release: () => void = () => undefined;
  let started = false;
  let changes = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const agent: Agent = {
    async run(input) {
      started = true;
      await gate;
      const finalMessage = message({ role: 'assistant', content: 'late' });
      input.eventBus.emit('agent.message.done', { message: finalMessage });
      return { toolCalls: 0, message: finalMessage };
    },
  };
  const manager = new RunManager({
    runs: new Map(),
    agent,
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
    onSessionChanged: () => changes++,
  });

  const run = manager.createRun(session, { content: 'start' });
  await waitFor(() => started);
  const shutdown = manager.shutdown();
  release();
  await shutdown;

  assert.equal(run.status, 'cancelled');
  assert.equal(run.cancel_reason, 'shutdown');
  assert.equal(changes, 0);
  assert.deepEqual(session.messages, []);
  assert.throws(() => manager.createRun(session, { content: 'again' }), /shutting down/);
});

test('RunManager marks an explicit cancellation as user initiated', async () => {
  const session = createSession();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = new RunManager({
    runs: new Map(),
    agent: {
      async run() {
        await gate;
        return { toolCalls: 0, message: message({ role: 'assistant', content: 'late' }) };
      },
    },
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });
  const run = manager.createRun(session, { content: 'start' });
  await waitFor(() => run.status === 'running');
  manager.cancel(run.id);
  release();
  await waitFor(() => run.status === 'cancelled');
  assert.equal(run.cancel_reason, 'user');
});

test('RunManager resolves persisted image attachments before sending history to the agent', async () => {
  const session = createSession();
  const attachment: ImageAttachment = {
    id: 'img_history',
    kind: 'image',
    mime_type: 'image/png',
    relative_path: 'attachments/blobs/abc.png',
    size: 8,
    sha256: 'a'.repeat(64),
  };
  session.messages.push(
    message({ role: 'user', content: 'image', attachments: [attachment] }),
    message({ role: 'user', content: 'current' }),
  );
  let historyDataUrl = '';
  const agent: Agent = {
    async run(input) {
      const first = input.history?.[0];
      historyDataUrl = first?.role === 'user' ? first.attachments?.[0]?.data_url || '' : '';
      return { toolCalls: 0, message: message({ role: 'assistant', content: 'done' }) };
    },
  };
  const manager = new RunManager({
    runs: new Map(),
    agent,
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
    resolveImageAttachments: (attachments) => attachments.map((item) => ({
      ...item,
      data_url: 'data:image/png;base64,AA==',
    })),
  });

  const run = manager.createRun(session, { content: 'current' });
  await waitFor(() => run.status === 'completed');
  assert.equal(historyDataUrl, 'data:image/png;base64,AA==');
});
