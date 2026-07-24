import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MessagingRuntime } from './messaging-runtime.js';

test('runtime sends tool output through the durable outbox before returning', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-runtime-'));
  try {
    const harness = createHarness();
    const runtime = new MessagingRuntime(
      harness.store as never,
      harness.connections as never,
      {} as never,
      {} as never,
      {} as never,
      directory,
      () => [directory],
    );
    const result = await runtime.send({
      binding_id: 'bind_1',
      idempotency_key: 'run_1:tool:call_1',
      contents: [{ type: 'text', text: 'done' }],
    });
    assert.equal(harness.delivered.length, 1);
    assert.equal(harness.delivered[0]?.kind, 'message');
    assert.equal(result.receipts[0]?.type, 'text');
    await runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime owns Weixin connection activation after login', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-runtime-'));
  try {
    const harness = createHarness();
    const runtime = new MessagingRuntime(
      harness.store as never,
      harness.connections as never,
      {} as never,
      {} as never,
      {} as never,
      directory,
      () => [directory],
    );
    const connection = await runtime.completeWeixinLogin({
      name: 'WeChat',
      ilinkBotId: 'bot_1',
      apiBaseUrl: 'https://example.test',
      token: 'secret',
    });
    assert.equal(connection.id, 'wxconn_1');
    assert.deepEqual(harness.startedConnections, ['wxconn_1']);
    await runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime marks a permanent delivery failure instead of reporting success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-runtime-'));
  try {
    const harness = createHarness(new Error('UNSUPPORTED_CAPABILITY: media'));
    const runtime = new MessagingRuntime(
      harness.store as never,
      harness.connections as never,
      {} as never,
      {} as never,
      {} as never,
      directory,
      () => [directory],
    );
    await assert.rejects(
      () => runtime.send({ binding_id: 'bind_1', idempotency_key: 'run_1:tool:call_2', contents: [{ type: 'text', text: 'done' }] }),
      /UNSUPPORTED_CAPABILITY/,
    );
    assert.equal(harness.jobs[0]?.state, 'failed');
    await runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness(deliveryError?: Error) {
  const jobs: Array<Record<string, any>> = [];
  const delivered: Array<Record<string, unknown>> = [];
  const startedConnections: string[] = [];
  const weixinConnection = {
    id: 'wxconn_1',
    platform: 'weixin',
    name: 'WeChat',
    enabled: true,
    state: 'connected',
  };
  const store = {
    createConnection() { return weixinConnection; },
    updateConnectionState() { return weixinConnection; },
    enqueueOutboundJob(input: Record<string, any>) {
      const existing = jobs.find((job) => job.idempotency_key === input.idempotencyKey);
      if (existing) return existing;
      const job = {
        id: `out_${jobs.length + 1}`,
        idempotency_key: input.idempotencyKey,
        binding_id: input.bindingId,
        operation: input.operation,
        state: 'pending',
        attempt_count: 0,
        next_attempt_at: new Date().toISOString(),
        receipts: [],
        ...input,
      };
      jobs.push(job);
      return job;
    },
    getOutboundJob(key: string) { return jobs.find((job) => job.idempotency_key === key) || null; },
    claimDueOutboundJobs() {
      return jobs.filter((job) => job.state === 'pending').map((job) => {
        job.state = 'sending';
        return job;
      });
    },
    getNextOutboundAttemptAt() {
      return jobs
        .filter((job) => job.state === 'pending')
        .sort((left, right) => String(left.next_attempt_at).localeCompare(String(right.next_attempt_at)))[0]?.next_attempt_at;
    },
    getBinding() {
      return { id: 'bind_1', platform: 'weixin', account_id: 'conn_1', conversation_id: 'user_1', conversation_type: 'direct' };
    },
    getLatestOutboundReference() { return undefined; },
    completeOutboundJob(id: string, result: any) {
      const job = jobs.find((item) => item.id === id)!;
      job.state = 'delivered';
      job.receipts = result.receipts;
      return job;
    },
    retryOutboundJob() { throw new Error('not expected'); },
    failOutboundJob(id: string, error: string) {
      const job = jobs.find((item) => item.id === id)!;
      job.state = 'failed';
      job.error = error;
      return job;
    },
  };
  const connections = {
    setEventHandler() {},
    async start(connectionId: string) {
      startedConnections.push(connectionId);
      return weixinConnection;
    },
    async deliver(_binding: unknown, operation: Record<string, unknown>) {
      if (deliveryError) throw deliveryError;
      delivered.push(operation);
      return { receipts: [{ type: 'text', delivered_at: '2026-01-01T00:00:00.000Z' }] };
    },
    async close() {},
  };
  return { store, connections, jobs, delivered, startedConnections };
}
