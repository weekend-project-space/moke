import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeRun } from '@moke/agent-runtime';
import type { AgentEvent } from '@moke/protocol';
import { MessagingDeliveryService } from './delivery-service.js';
import type { MessagingConnectionManager } from './connection-manager.js';

test('terminal delivery remains pending until the outbound message completes', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const connections = {
    stopTypingForRun: async () => undefined,
    sendTextForBinding: async () => gate,
  } as unknown as MessagingConnectionManager;
  const delivery = new MessagingDeliveryService(connections);
  const run = {
    id: 'run_1',
    origin: {
      kind: 'messaging',
      platform: 'weixin',
      connection_id: 'wxconn_1',
      binding_id: 'bind_1',
      inbound_message_id: 'message_1',
    },
  } as RuntimeRun;
  delivery.onRunEvent({
    type: 'agent.message.done',
    payload: { message: { role: 'assistant', content: 'done', created_at: new Date().toISOString() } },
  } as unknown as AgentEvent, run);
  delivery.onRunEvent({ type: 'agent.done', payload: { status: 'completed', usage: { steps: 1, tool_calls: 0, duration_ms: 1 } } } as AgentEvent, run);
  let completed = false;
  const waiting = delivery.waitForTerminal(run.id).then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await waiting;
  assert.equal(completed, true);
});

test('Feishu delivery updates one run card instead of sending a second final message', async () => {
  const cards: Array<{ operation: string; presentation: { content: string } }> = [];
  const connections = {
    getBindingPlatform: () => 'feishu',
    createRunCardForBinding: async (_connectionId: string, _bindingId: string, presentation: { content: string }) => {
      cards.push({ operation: 'create', presentation });
      return { platform: 'feishu', messageId: 'om_card' };
    },
    updateRunCard: async (_connectionId: string, _handle: unknown, presentation: { content: string }) => {
      cards.push({ operation: 'update', presentation });
    },
    stopTypingForRun: async () => undefined,
  } as unknown as MessagingConnectionManager;
  const delivery = new MessagingDeliveryService(connections);
  const run = {
    id: 'run_feishu',
    origin: { kind: 'messaging', platform: 'feishu', connection_id: 'fsconn_1', binding_id: 'bind_1', inbound_message_id: 'om_1' },
  } as RuntimeRun;

  delivery.onRunStarted({ connectionId: 'fsconn_1', bindingId: 'bind_1', runId: run.id });
  delivery.onRunEvent({
    type: 'agent.message.done',
    payload: { message: { role: 'assistant', content: 'Finished', created_at: new Date().toISOString() } },
  } as AgentEvent, run);
  delivery.onRunEvent({ type: 'agent.done', payload: { status: 'completed' } } as AgentEvent, run);
  await delivery.waitForTerminal(run.id);

  assert.deepEqual(cards.map((item) => item.operation), ['create', 'update']);
  assert.match(JSON.stringify(cards[1]?.presentation), /Finished/);
});

test('answering an ask updates the original interaction card without actions', async () => {
  const created: Array<{ content: string; actions: Array<{ value: Record<string, unknown> }> }> = [];
  const updated: Array<{ title: string; content: string }> = [];
  const connections = {
    stopTypingForRun: async () => undefined,
    startTypingForBinding: () => undefined,
    getBindingSender: () => 'ou_owner',
    createInteractionCardForBinding: async (_connectionId: string, _bindingId: string, input: typeof created[number]) => {
      created.push(input);
      return { platform: 'feishu', messageId: 'om_interaction' };
    },
    updateInteractionCard: async (_connectionId: string, _handle: unknown, input: typeof updated[number]) => {
      updated.push(input);
    },
  } as unknown as MessagingConnectionManager;
  const delivery = new MessagingDeliveryService(connections);
  const run = {
    id: 'run_ask',
    outbound_tool_texts: ['The task completed without a text result.'],
    origin: { kind: 'messaging', platform: 'feishu', connection_id: 'fsconn_1', binding_id: 'bind_1', inbound_message_id: 'om_1' },
  } as RuntimeRun;

  delivery.onRunEvent({
    type: 'ask_user.required',
    payload: {
      ask_id: 'ask_1', call_id: 'call_1', question: 'Continue?', created_at: new Date().toISOString(),
      options: [{ id: 'yes', label: 'Continue' }],
    },
  } as AgentEvent, run);
  await tick();
  delivery.onRunEvent({
    type: 'ask_user.answered',
    payload: { ask_id: 'ask_1', call_id: 'call_1', selected: { id: 'yes', label: 'Continue' } },
  } as AgentEvent, run);
  delivery.onRunEvent({ type: 'agent.done', payload: { status: 'completed' } } as AgentEvent, run);
  await tick();

  assert.equal(created.length, 1);
  assert.equal(created[0]?.actions[0]?.value.responderOpenId, 'ou_owner');
  assert.deepEqual(updated, [{ title: 'Response received', content: 'Continue?\n\n**Selected:** Continue' }]);
});

test('approval interaction includes tool and risk details and becomes read-only after resolution', async () => {
  let createdContent = '';
  let resolvedContent = '';
  const connections = {
    stopTypingForRun: async () => undefined,
    startTypingForBinding: () => undefined,
    getBindingSender: () => 'staff_owner',
    createInteractionCardForBinding: async (_connectionId: string, _bindingId: string, input: { content: string }) => {
      createdContent = input.content;
      return { platform: 'dingtalk', card: { id: 'card_1', started: false } };
    },
    updateInteractionCard: async (_connectionId: string, _handle: unknown, input: { content: string }) => {
      resolvedContent = input.content;
    },
  } as unknown as MessagingConnectionManager;
  const delivery = new MessagingDeliveryService(connections);
  const run = {
    id: 'run_approval',
    origin: { kind: 'messaging', platform: 'dingtalk', connection_id: 'dtconn_1', binding_id: 'bind_1', inbound_message_id: 'msg_1' },
  } as RuntimeRun;

  delivery.onRunEvent({
    type: 'approval.required',
    payload: {
      approval_id: 'approval_1', call_id: 'call_1', kind: 'tool', reason: 'Run a command', risk: 'high',
      action: { tool: 'shell_command', input: { command: 'npm test' } }, created_at: new Date().toISOString(),
    },
  } as unknown as AgentEvent, run);
  await tick();
  delivery.onRunEvent({
    type: 'approval.resolved',
    payload: { approval_id: 'approval_1', decision: 'approved', scope: 'once' },
  } as AgentEvent, run);
  await tick();

  assert.match(createdContent, /shell_command/);
  assert.match(createdContent, /high/);
  assert.match(resolvedContent, /Allowed for once/);
});

async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
