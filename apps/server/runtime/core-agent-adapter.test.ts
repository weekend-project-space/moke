import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentEvent as CoreAgentEvent } from '@moke/agent-protocol';
import { EventBus, type RuntimeRun } from '@moke/agent-runtime';
import type { AgentEvent } from '@moke/protocol';

import { forwardCoreEvents } from './core-agent-adapter.js';

test('persists one complete assistant message for streamed text and multiple tool calls', async () => {
  const timestamp = '2026-08-13T01:00:00.000Z';
  const events = [
    coreEvent({ type: 'step.started', stepId: 'step_1', stepName: 'model-1' }, 1, timestamp),
    coreEvent({ type: 'message.started', stepId: 'step_1', messageId: 'msg_1', role: 'assistant' }, 2, timestamp),
    coreEvent({ type: 'message.content', stepId: 'step_1', messageId: 'msg_1', delta: 'I will check both.' }, 3, timestamp),
    coreEvent({ type: 'tool_call.started', stepId: 'step_1', toolCallId: 'call_1', toolCallName: 'read', parentMessageId: 'msg_1' }, 4, timestamp),
    coreEvent({ type: 'tool_call.args', stepId: 'step_1', toolCallId: 'call_1', delta: '{"path":"a"}' }, 5, timestamp),
    coreEvent({ type: 'tool_call.completed', stepId: 'step_1', toolCallId: 'call_1' }, 6, timestamp),
    coreEvent({ type: 'tool_call.started', stepId: 'step_1', toolCallId: 'call_2', toolCallName: 'read', parentMessageId: 'msg_1' }, 7, timestamp),
    coreEvent({ type: 'tool_call.args', stepId: 'step_1', toolCallId: 'call_2', delta: '{"path":"b"}' }, 8, timestamp),
    coreEvent({ type: 'tool_call.completed', stepId: 'step_1', toolCallId: 'call_2' }, 9, timestamp),
    coreEvent({
      type: 'message.completed',
      stepId: 'step_1',
      messageId: 'msg_1',
      reasoning: 'Need both files.',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: 'I will check both.',
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
          { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
        ],
      },
    }, 10, timestamp),
  ];
  const runtimeEvents: AgentEvent[] = [];
  const run = runtimeRun();
  const completed = await forwardCoreEvents(asAsync(events), {
    eventBus: new EventBus(run, event => runtimeEvents.push(event)),
  });
  const messages = runtimeEvents
    .filter(event => event.type === 'agent.message.done')
    .map(event => event.type === 'agent.message.done' ? event.payload.message : undefined);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    id: 'msg_1',
    role: 'assistant',
    content: 'I will check both.',
    created_at: timestamp,
    reasoning: 'Need both files.',
    tool_calls: [
      { id: 'call_1', name: 'read', args: { path: 'a' } },
      { id: 'call_2', name: 'read', args: { path: 'b' } },
    ],
  });
  assert.deepEqual(completed.get('msg_1'), messages[0]);
});

function coreEvent(
  input: CoreAgentEvent extends infer Event
    ? Event extends CoreAgentEvent
      ? Omit<Event, 'eventId' | 'sequence' | 'threadId' | 'runId' | 'timestamp'>
      : never
    : never,
  sequence: number,
  timestamp: string,
): CoreAgentEvent {
  return { ...input, eventId: `evt_${sequence}`, sequence, threadId: 'sess_1', runId: 'run_1', timestamp } as CoreAgentEvent;
}

async function* asAsync(events: CoreAgentEvent[]) {
  yield* events;
}

function runtimeRun(): RuntimeRun {
  return {
    id: 'run_1',
    session_id: 'sess_1',
    status: 'running',
    seq: 0,
    events: [],
    clients: new Set(),
    started_at: Date.now(),
    abort: false,
    origin: { kind: 'local' },
    approval_mode: 'manual',
    env: {
      workspace: { root: process.cwd() },
      approval_mode: 'manual',
      reasoningEffort: 'medium',
      system: { platform: 'windows', arch: 'x64', shell: 'powershell.exe' },
    },
  };
}
