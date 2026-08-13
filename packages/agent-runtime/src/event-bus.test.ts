import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeRun } from './run-state.js';
import { EventBus, MAX_RETAINED_RUN_EVENTS } from './event-bus.js';

function run(clients = new Set()): RuntimeRun {
  return { id: 'run_test', session_id: 'session_test', status: 'running', seq: 0, events: [], clients, started_at: Date.now(), abort: false };
}

test('EventBus assigns monotonic sequence and numeric timestamp', () => {
  const state = run();
  const bus = new EventBus(state);
  const first = bus.emit({ type: 'step.started', stepId: 'step_1', stepName: 'model' });
  const second = bus.emit({ type: 'step.completed', stepId: 'step_1', stepName: 'model' });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(typeof first.timestamp, 'number');
  assert.equal(first.threadId, 'session_test');
  assert.equal(first.runId, 'run_test');
});

test('EventBus caps retained events without resetting sequence', () => {
  const state = run();
  const bus = new EventBus(state);
  for (let i = 0; i < MAX_RETAINED_RUN_EVENTS + 5; i++) bus.emit({ type: 'custom', name: 'test', value: i });
  assert.equal(state.events.length, MAX_RETAINED_RUN_EVENTS);
  assert.equal(state.events[0]?.sequence, 6);
  assert.equal(state.events.at(-1)?.sequence, MAX_RETAINED_RUN_EVENTS + 5);
});

test('EventBus hides internal custom events and closes clients on terminal events', () => {
  const writes: string[] = [];
  const client = { write(value: string) { writes.push(value); }, end() { writes.push('END'); } } as never;
  const state = run(new Set([client]));
  const bus = new EventBus(state);
  bus.emit({ type: 'custom', name: 'moke.internal.message', value: { content: 'internal' } });
  assert.equal(writes.length, 0);
  bus.emit({ type: 'run.completed', result: undefined });
  assert.match(writes[0] || '', /run\.completed/);
  assert.equal(writes.at(-1), 'END');
});
