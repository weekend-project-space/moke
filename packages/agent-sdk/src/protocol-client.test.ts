import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentProtocolClient } from './protocol-client.js';
import type { AgentEvent } from '@moke/agent-protocol';

const base = { eventId: 'e1', sequence: 1, type: 'run.started', threadId: 't1', runId: 'r1', timestamp: '2026-08-12T00:00:00.000Z' } as AgentEvent;
function sse(events: AgentEvent[]) { const encoder = new TextEncoder(); return new Response(new ReadableStream<Uint8Array>({ start(controller) { const text = events.map(event => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join(''); const middle = Math.floor(text.length / 2); controller.enqueue(encoder.encode(text.slice(0, middle))); controller.enqueue(encoder.encode(text.slice(middle))); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); }

test('creates runs without serializing AbortSignal', async () => {
  let body: Record<string, unknown> = {};
  const client = new AgentProtocolClient({ baseUrl: 'http://agent', fetch: (async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ threadId: 't1', runId: 'r1', status: 'running' })); }) as typeof fetch });
  await client.createRun({ threadId: 't1', input: 'hi' }, { signal: new AbortController().signal });
  assert.equal('signal' in body, false);
});

test('reconnects with Last-Event-ID and filters replayed sequences', async () => {
  const headers: Array<string | null> = [];
  let requests = 0;
  const done = { ...base, eventId: 'e2', sequence: 2, type: 'run.cancelled', reason: 'done' } as AgentEvent;
  const client = new AgentProtocolClient({ baseUrl: '', maxReconnectDelayMs: 0, fetch: (async (_url, init) => { headers.push(new Headers(init?.headers).get('Last-Event-ID')); return ++requests === 1 ? sse([base]) : sse([base, done]); }) as typeof fetch });
  const received: AgentEvent[] = [];
  for await (const event of client.events('r1')) received.push(event);
  assert.deepEqual(received.map(event => event.sequence), [1, 2]);
  assert.deepEqual(headers, [null, '1']);
});
