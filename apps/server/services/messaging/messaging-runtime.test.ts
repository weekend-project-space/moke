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
    }, {
      workspaceRoot: join(directory, 'session-workspace'),
      approvedRoots: [join(directory, 'approved-once')],
    });
    assert.equal(harness.delivered.length, 1);
    assert.equal(harness.delivered[0]?.kind, 'message');
    assert.equal(result.receipts[0]?.type, 'text');
    assert.equal(harness.jobs[0]?.operation.workspace_root, join(directory, 'session-workspace'));
    assert.deepEqual(harness.jobs[0]?.operation.approved_roots, [join(directory, 'approved-once')]);
    assert.equal('workspace_root' in harness.delivered[0], false);
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

test('runtime resolves a session binding before a platform-wide binding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-runtime-'));
  try {
    const harness = createHarness();
    harness.messagingConnections.push(
      connectedConnection('fsconn_session', 'feishu'),
      connectedConnection('fsconn_other', 'feishu'),
    );
    harness.bindings.push(
      binding('bind_session', 'fsconn_session', 'feishu', 'sess_local'),
      binding('bind_other', 'fsconn_other', 'feishu', 'sess_other'),
    );
    const runtime = new MessagingRuntime(
      harness.store as never,
      harness.connections as never,
      {} as never,
      {} as never,
      {} as never,
      directory,
      () => [directory],
    );

    assert.deepEqual(runtime.resolveTarget({ platform: 'feishu', sessionId: 'sess_local' }), {
      status: 'resolved',
      target: {
        bindingId: 'bind_session',
        platform: 'feishu',
        connectionId: 'fsconn_session',
        conversationId: 'conversation_bind_session',
        conversationType: 'direct',
      },
    });
    assert.deepEqual(runtime.resolveTarget({ platform: 'feishu', sessionId: 'sess_missing' }), {
      status: 'ambiguous',
      count: 2,
    });
    assert.deepEqual(runtime.resolveTarget({ platform: 'dingtalk', sessionId: 'sess_local' }), { status: 'not_found' });
    await runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime excludes bindings without an available connection when resolving a target', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-runtime-'));
  try {
    const harness = createHarness();
    harness.messagingConnections.push(
      connectedConnection('wxconn_active', 'weixin'),
      { ...connectedConnection('wxconn_disabled', 'weixin'), enabled: false },
      { ...connectedConnection('wxconn_stopped', 'weixin'), state: 'stopped' },
      connectedConnection('fsconn_wrong_platform', 'feishu'),
    );
    harness.bindings.push(
      binding('bind_orphan', 'wxconn_missing', 'weixin', 'sess_local'),
      binding('bind_disabled', 'wxconn_disabled', 'weixin', 'sess_other'),
      binding('bind_stopped', 'wxconn_stopped', 'weixin', 'sess_other'),
      binding('bind_wrong_platform', 'fsconn_wrong_platform', 'weixin', 'sess_other'),
      binding('bind_active', 'wxconn_active', 'weixin', 'sess_other'),
    );
    const runtime = new MessagingRuntime(
      harness.store as never,
      harness.connections as never,
      {} as never,
      {} as never,
      {} as never,
      directory,
      () => [directory],
    );

    assert.deepEqual(runtime.resolveTarget({ platform: 'weixin', sessionId: 'sess_local' }), {
      status: 'resolved',
      target: {
        bindingId: 'bind_active',
        platform: 'weixin',
        connectionId: 'wxconn_active',
        conversationId: 'conversation_bind_active',
        conversationType: 'direct',
      },
    });
    await runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime keeps inbound work queued until the session active run finishes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-runtime-'));
  try {
    const binding = { id: 'bind_queued', platform: 'weixin', account_id: 'wxconn_1', session_id: 'sess_busy' };
    const session = { id: 'sess_busy' };
    const job = { id: 'in_queued', text: 'next', platform_message_id: 'msg_queued', state: 'queued' };
    let active = true;
    let claims = 0;
    let accepted = 0;
    const runtime = new MessagingRuntime(
      {
        getBinding: () => binding,
        listBindings: () => [binding],
        claimNextInboundJob: () => {
          claims++;
          job.state = 'running';
          return job;
        },
        setInboundRun: () => true,
      } as never,
      { setEventHandler() {}, async close() {} } as never,
      {
        getSession: () => session,
        acceptUserMessage(input: { options?: { beforeStart?: (run: { id: string }) => void } }) {
          accepted++;
          input.options?.beforeStart?.({ id: 'run_messaging' });
          return { runId: 'run_messaging' };
        },
      } as never,
      { getActiveRunForSession: () => active ? { id: 'run_local' } : undefined } as never,
      {} as never,
      directory,
      () => [directory],
    );

    await (runtime as unknown as { drainBinding(id: string): Promise<void> }).drainBinding(binding.id);
    assert.equal(claims, 0);
    assert.equal(accepted, 0);

    active = false;
    runtime.onRunEvent({ type: 'run.completed' } as never, {
      id: 'run_local', session_id: session.id, origin: { kind: 'local' },
    } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(claims, 1);
    assert.equal(accepted, 1);
    await runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness(deliveryError?: Error) {
  const jobs: Array<Record<string, any>> = [];
  const delivered: Array<Record<string, unknown>> = [];
  const startedConnections: string[] = [];
  const bindings: Array<Record<string, string>> = [];
  const messagingConnections: Array<Record<string, unknown>> = [];
  const weixinConnection = {
    id: 'wxconn_1',
    platform: 'weixin',
    name: 'WeChat',
    enabled: true,
    state: 'connected',
  };
  const store = {
    listConnections() { return messagingConnections; },
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
    listBindings(input: { platform?: string } = {}) {
      return bindings.filter((binding) => !input.platform || binding.platform === input.platform);
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
  return { store, connections, jobs, delivered, startedConnections, bindings, messagingConnections };
}

function connectedConnection(id: string, platform: 'weixin' | 'dingtalk' | 'feishu') {
  return { id, platform, enabled: true, state: 'connected' };
}

function binding(id: string, accountId: string, platform: 'weixin' | 'dingtalk' | 'feishu', sessionId: string) {
  return {
    id,
    account_id: accountId,
    platform,
    session_id: sessionId,
    conversation_id: `conversation_${id}`,
    conversation_type: 'direct',
  };
}
