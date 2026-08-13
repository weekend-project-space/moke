import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunSnapshot } from '@moke/agent-protocol';
import type { AgentEvent, AgentRunInput } from '@moke/agent-protocol';
import { AgentRuntime, MemoryEventStore } from './core-runtime.js';
import { createAgentHttpHandler } from './http-transport.js';

test('HTTP handler creates a run and exposes replayable SSE events', async () => {
  const events: AgentEvent[] = [
    { eventId: 'e1', sequence: 1, type: 'run.started', threadId: 't1', runId: 'r1', timestamp: Date.parse('2026-08-12T00:00:00.000Z') },
    { eventId: 'e2', sequence: 2, type: 'run.cancelled', threadId: 't1', runId: 'r1', timestamp: Date.parse('2026-08-12T00:00:01.000Z'), reason: 'done' },
  ];
  const run = { runId: 'r1', events: async function* () { for (const event of events) yield event; }, snapshot: () => ({ ...createAgentRunSnapshot('t1', 'r1'), status: 'cancelled' as const, lastSequence: 2 }), respond: async () => undefined, cancel: () => undefined };
  const runtime = new AgentRuntime({ agent: { run: (_input: AgentRunInput) => run }, eventStore: new MemoryEventStore() });
  const handler = createAgentHttpHandler(runtime);
  const created = await handler(new Request('http://local/api/agent/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 't1', input: 'hi' }) }));
  assert.equal(created.status, 201);
  await new Promise(resolve => setImmediate(resolve));
  const response = await handler(new Request('http://local/api/agent/runs/r1/events', { headers: { 'Last-Event-ID': '1' } }));
  const text = await response.text();
  assert.match(text, /"sequence":2/);
  assert.doesNotMatch(text, /"sequence":1/);
});
