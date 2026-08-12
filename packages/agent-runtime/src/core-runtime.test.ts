import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEventStore, MemoryInteractionBroker, MemoryRunStore } from './core-runtime.js';
import type { AgentEvent, AgentRunCheckpoint } from '@moke/agent-protocol';

const base = { eventId: 'e1', sequence: 1, type: 'step.started', threadId: 't1', runId: 'r1', timestamp: new Date().toISOString(), stepId: 's1', stepName: 'model-1' } satisfies AgentEvent;

test('event store appends idempotently and replays after sequence', async () => {
  const store = new MemoryEventStore();
  await store.append(base); await store.append(base);
  await store.append({ ...base, eventId: 'e2', sequence: 2, type: 'step.completed' });
  assert.deepEqual((await store.list('r1')).map(event => event.sequence), [1, 2]);
  assert.deepEqual((await store.list('r1', 1)).map(event => event.sequence), [2]);
});

test('run store isolates persisted checkpoints', async () => {
  const store = new MemoryRunStore();
  const checkpoint: AgentRunCheckpoint = { version: 1, threadId: 't1', runId: 'r1', status: 'awaiting_user', nextStepIndex: 1, messages: [], state: { count: 1 }, usage: { steps: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, pendingInteraction: { id: 'i1', type: 'question', question: 'Continue?', allowText: true }, pendingToolCalls: [] };
  await store.saveCheckpoint('r1', checkpoint); checkpoint.state.count = 2;
  assert.equal((await store.loadCheckpoint('r1'))?.state.count, 1);
});

test('interaction broker resolves the pending request exactly once', async () => {
  const broker = new MemoryInteractionBroker();
  const waiting = broker.request('r1', { id: 'i1', type: 'question', question: 'Continue?', allowText: true });
  await broker.resolve({ interactionId: 'i1', decision: 'answered', answer: 'yes', idempotencyKey: 'k1' });
  assert.equal((await waiting).answer, 'yes');
  assert.equal(await broker.pending('r1'), undefined);
  await assert.rejects(broker.resolve({ interactionId: 'i1', decision: 'answered', answer: 'again', idempotencyKey: 'k2' }), /Unknown interaction/);
});
