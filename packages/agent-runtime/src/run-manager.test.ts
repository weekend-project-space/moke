import assert from 'node:assert/strict';
import test from 'node:test';

import type { Message, Session, ToolApprovalRecord } from '../../protocol/src/index.js';
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
    sessions: new Map([[session.id, session]]),
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
    sessions: new Map([[session.id, session]]),
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
