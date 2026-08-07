import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import type { ImageAttachment, Message, RunLifecycleEvent, Session, ToolApprovalRecord } from '@moke/protocol';
import type { Agent } from './agent.js';
import { RunManager, selectRecentHistory, SessionRunActiveError } from './run-manager.js';
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

test('RunManager fails a run when skill context initialization fails', async () => {
  const session = createSession();
  const runs = new Map();
  let agentCalled = false;
  const errors: string[] = [];
  const manager = new RunManager({
    runs,
    agent: {
      async run() {
        agentCalled = true;
        return { toolCalls: 0, message: message({ role: 'assistant', content: 'done' }) };
      },
    },
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
    createSkillContentManager: async () => {
      throw new Error('skill catalog unavailable');
    },
  });
  manager.addObserver((event) => {
    if (event.type === 'agent.error') errors.push(event.payload.message);
  });

  const run = manager.createRun(session, { content: 'start' });
  await waitFor(() => run.status === 'failed');

  assert.equal(agentCalled, false);
  assert.deepEqual(errors, ['skill catalog unavailable']);
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
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

test('RunManager allows only one active run per session', async () => {
  const session = createSession();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = new RunManager({
    runs: new Map(),
    agent: {
      async run() {
        await gate;
        return { toolCalls: 0, message: message({ role: 'assistant', content: 'done' }) };
      },
    },
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });

  const first = manager.createRun(session, { content: 'first' });
  assert.equal(manager.getActiveRunForSession(session.id)?.id, first.id);
  assert.throws(
    () => manager.createRun(session, { content: 'second' }),
    (error: unknown) => error instanceof SessionRunActiveError
      && error.sessionId === session.id
      && error.runId === first.id,
  );

  release();
  await waitFor(() => first.status === 'completed');
  assert.equal(manager.getActiveRunForSession(session.id), undefined);

  const next = manager.createRun(session, { content: 'next' });
  await waitFor(() => next.status === 'completed');
});

test('RunManager times out the whole run and clears a pending approval', async () => {
  const session = createSession();
  let aborted = false;
  const manager = new RunManager({
    runs: new Map(),
    agent: {
      async run(input) {
        input.context.abortSignal?.addEventListener('abort', () => { aborted = true; }, { once: true });
        await input.context.approveTool?.({
          callId: 'call_timeout',
          tool: 'execute',
          input: { command: 'npm test' },
          reason: 'Run tests',
        });
        return { toolCalls: 1, message: message({ role: 'assistant', content: 'late' }) };
      },
    },
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });

  const run = manager.createRun(session, { content: 'start' }, { timeout_ms: 20 });
  await waitFor(() => Boolean(run.pending_approval));
  const approvalId = run.pending_approval?.approval_id || '';
  await waitFor(() => run.status === 'timeout');

  assert.equal(aborted, true);
  assert.equal(run.pending_approval, undefined);
  assert.equal(manager.approve(run.id, approvalId, 'approved').status, 409);
  assert.equal(manager.getActiveRunForSession(session.id), undefined);
  assert.equal(
    run.events.filter((event) => event.type === 'agent.done').at(-1)?.payload.status,
    'timeout',
  );
  assert.match(session.messages.at(-1)?.content || '', /timed out after 20ms/);
});

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
    reviewer: 'user',
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
      return {
        toolCalls: 1,
        message: finalMessage,
        usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 75, uncached_input_tokens: 25 },
      };
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
  const done = run.events.find((event) => event.type === 'agent.done');
  assert.equal(done?.type === 'agent.done' ? done.payload.usage?.cached_input_tokens : undefined, 75);
});

test('RunManager carries internal session context into the next run history', async () => {
  const session = createSession();
  let invocation = 0;
  let nextRunHistory: Message[] = [];
  const agent: Agent = {
    async run(input) {
      invocation++;
      if (invocation === 1) {
        input.eventBus.emit('agent.message.done', {
          message: message({
            role: 'user',
            content: '<active_skill id="openwalk-usage">instructions</active_skill>',
            visibility: 'internal',
          }),
        });
      } else {
        nextRunHistory = input.history || [];
      }
      return { toolCalls: 0, message: message({ role: 'assistant', content: 'done' }) };
    },
  };
  const manager = new RunManager({
    runs: new Map(),
    agent,
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });

  const firstRun = manager.createRun(session, { content: 'start' });
  await waitFor(() => firstRun.status === 'completed');
  const secondRun = manager.createRun(session, { content: 'continue' });
  await waitFor(() => secondRun.status === 'completed');

  const persisted = session.messages.find((item) => item.visibility === 'internal');
  const restored = nextRunHistory.find((item) => item.visibility === 'internal');
  assert.equal(restored?.id, persisted?.id);
  assert.equal(restored?.role, 'user');
  assert.equal(restored?.content, '<active_skill id="openwalk-usage">instructions</active_skill>');
  assert.equal(restored?.visibility, 'internal');
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

test('RunManager freezes the session environment and uses its workspace for the run', async () => {
  const session = createSession();
  session.env = {
    approval_mode: 'ai_review',
    model: { provider_id: 'provider_openai', name: 'gpt-5' },
    reasoningEffort: 'high',
    system: { platform: 'windows', arch: 'x64', shell: 'powershell.exe' },
    workspace: { root: 'E:\\work\\project-a' },
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let skillWorkspace = '';
  let agentWorkspace = '';
  let registryWorkspace = '';
  let agentTools: string[] = [];
  const baseRegistry = new ToolRegistry();
  const manager = new RunManager({
    runs: new Map(),
    agent: {
      async run(input) {
        agentWorkspace = input.context.workspace;
        agentTools = input.toolRegistry.list().map((tool) => tool.name);
        return { toolCalls: 0, message: message({ role: 'assistant', content: 'done' }) };
      },
    },
    toolRegistry: baseRegistry,
    defaultWorkspaceRoot: 'E:\\work\\default',
    resolveToolRegistry: async (workspace) => {
      registryWorkspace = workspace;
      return baseRegistry.withTools([{
        name: 'workspace_tool',
        description: 'Workspace tool',
        approval: 'none',
        schema: z.object({}),
        async handler() { return { ok: true }; },
      }]);
    },
    createSkillContentManager: async (workspace) => {
      skillWorkspace = workspace;
      await gate;
      return {
        addSkill: () => ({ status: 'unavailable' }),
        buildInitialContext: () => [],
      };
    },
  });

  const run = manager.createRun(session, { content: 'start' });
  await waitFor(() => skillWorkspace !== '');
  session.env.workspace.root = 'E:\\work\\project-b';
  session.env.approval_mode = 'auto_approve';
  release();
  await waitFor(() => run.status === 'completed');

  assert.equal(run.env.workspace.root, 'E:\\work\\project-a');
  assert.equal(run.approval_mode, 'ai_review');
  assert.deepEqual(run.env.model, { provider_id: 'provider_openai', name: 'gpt-5' });
  assert.equal(run.env.reasoningEffort, 'high');
  assert.equal(skillWorkspace, 'E:\\work\\project-a');
  assert.equal(agentWorkspace, 'E:\\work\\project-a');
  assert.equal(registryWorkspace, 'E:\\work\\project-a');
  assert.deepEqual(agentTools, ['workspace_tool']);
});

test('RunManager auto-approves tool decisions and records the reviewer', async () => {
  const session = createSession();
  session.env = {
    approval_mode: 'auto_approve',
    system: { platform: 'windows', arch: 'x64', shell: 'pwsh' },
    workspace: { root: process.cwd() },
  };
  let decision: { approved?: boolean; reviewer?: string } | undefined;
  const manager = new RunManager({
    runs: new Map(),
    agent: {
      async run(input) {
        decision = await input.context.approveTool?.({ tool: 'write_file', input: { path: 'a.md' }, callId: 'call_1', reason: 'Write file' });
        return { toolCalls: 1, message: message({ role: 'assistant', content: 'done' }) };
      },
    },
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });

  const run = manager.createRun(session, { content: 'write a file' });
  await waitFor(() => run.status === 'completed');
  assert.equal(decision?.approved, true);
  assert.equal(decision?.reviewer, 'auto_approve');
});

test('RunManager uses the AI reviewer decision without waiting for the user', async () => {
  const session = createSession();
  session.env = {
    approval_mode: 'ai_review',
    system: { platform: 'windows', arch: 'x64', shell: 'pwsh' },
    workspace: { root: process.cwd() },
  };
  const manager = new RunManager({
    runs: new Map(),
    agent: {
      async run(input) {
        const decision = await input.context.approveTool?.({ tool: 'write_file', input: { path: 'a.md' }, callId: 'call_1', reason: 'Write file' });
        assert.equal(decision?.approved, false);
        assert.equal(decision?.reviewer, 'ai');
        return { toolCalls: 1, message: message({ role: 'assistant', content: 'done' }) };
      },
    },
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
    aiApprovalReviewer: {
      async review() { return { decision: 'rejected', reason: 'Not requested by the user' }; },
    },
  });

  const run = manager.createRun(session, { content: 'summarize the file' });
  await waitFor(() => run.status === 'completed');
});

test('RunManager escalates an AI review to the user', async () => {
  const session = createSession();
  session.env = {
    approval_mode: 'ai_review',
    system: { platform: 'windows', arch: 'x64', shell: 'pwsh' }, workspace: { root: process.cwd() },
  };
  const manager = new RunManager({
    runs: new Map(),
    agent: {
      async run(input) {
        const decision = await input.context.approveTool?.({ tool: 'execute', input: { command: 'rm' }, callId: 'call_1', reason: 'Run command' });
        assert.equal(decision?.approved, true);
        assert.equal(decision?.reviewer, 'ai');
        return { toolCalls: 1, message: message({ role: 'assistant', content: 'done' }) };
      },
    },
    toolRegistry: new ToolRegistry(), workspace: process.cwd(),
    aiApprovalReviewer: { async review() { return { decision: 'escalated', reason: 'Destructive action' }; } },
  });
  const run = manager.createRun(session, { content: 'remove it' });
  await waitFor(() => Boolean(run.pending_approval));
  assert.equal(manager.approve(run.id, run.pending_approval?.approval_id || '', 'approved').status, 200);
  await waitFor(() => run.status === 'completed');
});

test('RunManager redacts sensitive tool parameters before publishing a user approval', async () => {
  const session = createSession();
  let manager: RunManager;
  manager = new RunManager({
    runs: new Map(),
    agent: {
      async run(input) {
        await input.context.approveTool?.({
          tool: 'send_message', input: { token: 'secret-value', text: 'hello' }, callId: 'call_1', reason: 'Send message',
        });
        return { toolCalls: 1, message: message({ role: 'assistant', content: 'done' }) };
      },
    },
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });
  const run = manager.createRun(session, { content: 'send hello' });
  await waitFor(() => Boolean(run.pending_approval));
  assert.equal(run.pending_approval?.action.input.token, '[REDACTED]');
  manager.cancel(run.id);
});
