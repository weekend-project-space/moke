import test from 'node:test';
import assert from 'node:assert/strict';
import { fromAgUiRunInput, toAgUiEvent } from './ag-ui.js';
import type { AgentEvent } from './types.js';

const base = { eventId: 'e1', sequence: 1, threadId: 't1', runId: 'r1', timestamp: '2026-08-12T00:00:00.000Z' };

test('converts AG-UI input and extracts the last user message as run input', () => {
  const input = fromAgUiRunInput({ threadId: 't1', runId: 'r1', state: { x: 1 }, messages: [{ id: 's1', role: 'system', content: 'system' }, { id: 'u1', role: 'user', content: 'hello' }], tools: [], context: [], forwardedProps: {} });
  assert.equal(input.input, 'hello');
  assert.deepEqual(input.messages, [{ id: 's1', role: 'system', content: 'system' }]);
});

test('rejects client-provided AG-UI tools', () => {
  assert.throws(() => fromAgUiRunInput({ threadId: 't1', runId: 'r1', state: {}, messages: [], tools: [{ name: 'client', description: 'client', parameters: {} }], context: [], forwardedProps: {} }), /not supported/);
});

test('maps core lifecycle events to AG-UI event names and fields', () => {
  const events: AgentEvent[] = [
    { ...base, type: 'message.started', messageId: 'm1', role: 'assistant' },
    { ...base, eventId: 'e2', sequence: 2, type: 'message.content', messageId: 'm1', delta: 'hi' },
    { ...base, eventId: 'e3', sequence: 3, type: 'tool_call.started', toolCallId: 'c1', toolCallName: 'read', parentMessageId: 'm1' },
    { ...base, eventId: 'e4', sequence: 4, type: 'state.delta', delta: [{ op: 'replace', path: '/phase', value: 'done' }] },
  ];
  assert.deepEqual(events.map(event => toAgUiEvent(event).type), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TOOL_CALL_START', 'STATE_DELTA']);
  assert.equal(toAgUiEvent(events[1]).delta, 'hi');
});
