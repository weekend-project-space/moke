import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeRun } from './run-state.js';
import { EventBus, MAX_RETAINED_RUN_EVENTS } from './event-bus.js';

test('EventBus caps retained events without resetting sequence numbers', () => {
  const run: RuntimeRun = {
    id: 'run_test',
    session_id: 'session_test',
    status: 'running',
    seq: 0,
    events: [],
    clients: new Set(),
    started_at: Date.now(),
    abort: false,
  };
  const bus = new EventBus(run);

  for (let index = 0; index < MAX_RETAINED_RUN_EVENTS + 5; index++) {
    bus.emit('agent.state', { state: 'reason' });
  }

  assert.equal(run.events.length, MAX_RETAINED_RUN_EVENTS);
  assert.equal(run.events[0]?.seq, 6);
  assert.equal(run.events.at(-1)?.seq, MAX_RETAINED_RUN_EVENTS + 5);
});
