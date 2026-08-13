import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent, AgentEventInput } from './types.js';
import { createAgentRunSnapshot, reduceAgentEvent } from './reducer.js';

function event(input: AgentEventInput, sequence: number): AgentEvent {
  return { ...input, eventId: `evt_${sequence}`, sequence, threadId: 'thread_1', runId: 'run_1', timestamp: 1_786_570_800_000 } as AgentEvent;
}

test('reducer requires matching identity and increasing sequence', () => {
  const snapshot = reduceAgentEvent(createAgentRunSnapshot('thread_1', 'run_1'), event({ type: 'run.started' }, 1));
  assert.throws(() => reduceAgentEvent(snapshot, event({ type: 'step.started', stepName: 'model' }, 1)), /sequence must increase/);
  assert.throws(() => reduceAgentEvent(snapshot, { ...event({ type: 'step.started', stepName: 'model' }, 2), runId: 'other' }), /identity/);
});

test('reducer preserves reasoning before assistant output in event order', () => {
  let snapshot = createAgentRunSnapshot('thread_1', 'run_1');
  snapshot = reduceAgentEvent(snapshot, event({ type: 'reasoning_message.started', messageId: 'reason_1', role: 'reasoning' }, 1));
  snapshot = reduceAgentEvent(snapshot, event({ type: 'reasoning_message.content', messageId: 'reason_1', delta: 'inspect' }, 2));
  snapshot = reduceAgentEvent(snapshot, event({ type: 'reasoning_message.completed', messageId: 'reason_1' }, 3));
  snapshot = reduceAgentEvent(snapshot, event({ type: 'message.started', messageId: 'msg_1', role: 'assistant' }, 4));
  snapshot = reduceAgentEvent(snapshot, event({ type: 'message.content', messageId: 'msg_1', delta: 'answer' }, 5));
  assert.deepEqual(snapshot.messages.map(message => [message.role, message.content]), [['reasoning', 'inspect'], ['assistant', 'answer']]);
});

test('reducer accumulates tool arguments and associates result', () => {
  let snapshot = createAgentRunSnapshot('thread_1', 'run_1');
  snapshot = reduceAgentEvent(snapshot, event({ type: 'message.started', messageId: 'msg_1', role: 'assistant' }, 1));
  snapshot = reduceAgentEvent(snapshot, event({ type: 'tool_call.started', toolCallId: 'call_1', toolCallName: 'read', parentMessageId: 'msg_1' }, 2));
  snapshot = reduceAgentEvent(snapshot, event({ type: 'tool_call.args', toolCallId: 'call_1', delta: '{"path":' }, 3));
  snapshot = reduceAgentEvent(snapshot, event({ type: 'tool_call.args', toolCallId: 'call_1', delta: '"a.ts"}' }, 4));
  snapshot = reduceAgentEvent(snapshot, event({ type: 'tool_result.completed', messageId: 'tool_1', toolCallId: 'call_1', content: 'ok' }, 5));
  const assistant = snapshot.messages[0];
  assert.equal(assistant?.role === 'assistant' ? assistant.toolCalls?.[0]?.function.arguments : '', '{"path":"a.ts"}');
  assert.equal(snapshot.messages[1]?.role, 'tool');
  assert.equal(snapshot.usage.toolCalls, 1);
});

test('interaction pause and resume preserve pending identity', () => {
  let snapshot = createAgentRunSnapshot('thread_1', 'run_1');
  snapshot = reduceAgentEvent(snapshot, event({ type: 'interaction.required', interaction: { id: 'ask_1', type: 'question', question: 'Continue?', allowText: true } }, 1));
  assert.equal(snapshot.status, 'awaiting_user');
  assert.equal(snapshot.pendingInteraction?.id, 'ask_1');
  snapshot = reduceAgentEvent(snapshot, event({ type: 'interaction.resolved', interactionId: 'ask_1', response: { interactionId: 'ask_1', decision: 'answered', answer: 'yes', idempotencyKey: 'ask_1' } }, 2));
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.pendingInteraction, undefined);
});
