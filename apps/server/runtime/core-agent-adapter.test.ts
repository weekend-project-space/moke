import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentEvent as CoreAgentEvent } from '@moke/agent-protocol';
import { EventBus, type RuntimeRun } from '@moke/agent-runtime';
import type { AgentEvent } from '@moke/protocol';

import { forwardCoreEvents, toLlmClientOptions } from './core-agent-adapter.js';

test('maps developer messages to system for OpenAI-compatible providers', () => {
  const options = toLlmClientOptions({
    apiKey: '',
    apiBaseUrl: 'http://localhost:8080/v1',
    maxRetries: 1,
    model: 'local-model',
    type: 'openai-compatible',
    reasoningEffort: 'medium',
    reasoningProvider: 'none',
    showRawReasoning: false,
    timeoutMs: 30_000,
  });

  assert.equal(options.compatible?.supportsDeveloperRole, false);
});

test('forwards one complete core assistant message and projects its runtime result', async () => {
  const timestamp = Date.parse('2026-08-13T01:00:00.000Z');
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
    .filter(event => event.type === 'message.completed')
    .map(event => event.type === 'message.completed' ? event.message : undefined);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    id: 'msg_1',
    role: 'assistant',
    content: 'I will check both.',
    toolCalls: [
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
      { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
    ],
  });
  assert.deepEqual(completed.get('msg_1'), {
    id: 'msg_1', role: 'assistant', content: 'I will check both.',
    created_at: new Date(timestamp).toISOString(), reasoning: 'Need both files.',
    tool_calls: [
      { id: 'call_1', name: 'read', args: { path: 'a' } },
      { id: 'call_2', name: 'read', args: { path: 'b' } },
    ],
  });
});

function coreEvent(
  input: CoreAgentEvent extends infer Event
    ? Event extends CoreAgentEvent
      ? Omit<Event, 'eventId' | 'sequence' | 'threadId' | 'runId' | 'timestamp'>
      : never
    : never,
  sequence: number,
  timestamp: number,
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
    approval_mode: 'read-only',
    env: {
      workspace: { root: process.cwd() },
      approval_mode: 'read-only',
      reasoningEffort: 'medium',
      system: { platform: 'windows', arch: 'x64', shell: 'powershell.exe' },
    },
  };
}
