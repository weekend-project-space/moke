import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonMessagingStore, MessagingStoreCorruptionError } from './messaging-store.js';

test('messaging store keeps tokens out of public connection records and scopes bindings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const connection = store.createConnection({
      name: '个人微信',
      ilinkBotId: 'bot@im.bot',
      apiBaseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'bot-token',
    });

    assert.equal(JSON.stringify(store.listConnections()).includes('bot-token'), false);
    const record = store.getConnection(connection.id)!;
    assert.equal(record.platform, 'weixin');
    assert.equal(store.getSecret(record.bot_token_secret_ref), 'bot-token');
    store.setAdapterState(connection.id, 'weixin.context:user@im.wechat', 'context-token');
    assert.equal(store.getAdapterState(connection.id, 'weixin.context:user@im.wechat'), 'context-token');

    const binding = store.createBinding({ connectionId: connection.id, conversationId: 'user@im.wechat', sessionId: 'sess_1' });
    assert.equal(store.getBinding(binding.id)?.session_id, 'sess_1');
    store.markBindingInbound(binding.id, 'message_0', 'user@im.wechat');
    assert.equal(store.getBinding(binding.id)?.last_sender_id, 'user@im.wechat');
    const connectionFile = readFileSync(join(directory, 'store', 'messaging', 'connections', `${connection.id}.json`), 'utf8');
    assert.equal(connectionFile.includes('bot-token'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps bindings for different messaging platforms separate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const weixin = store.createBinding({ connectionId: 'account_1', conversationId: 'conversation_1', sessionId: 'sess_weixin' });
    const dingtalk = store.createBinding({
      connectionId: 'account_1',
      conversationId: 'conversation_1',
      sessionId: 'sess_dingtalk',
      platform: 'dingtalk',
    });

    assert.equal(store.findBinding('account_1', 'conversation_1')?.id, weixin.id);
    assert.equal(store.findBinding('account_1', 'conversation_1', 'dingtalk')?.id, dingtalk.id);
    assert.deepEqual(store.listBindings({ platform: 'dingtalk' }).map((binding) => binding.id), [dingtalk.id]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stores DingTalk credentials and reply webhooks outside public records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const connection = store.createDingTalkConnection({
      name: '团队钉钉',
      clientId: 'ding-client-id',
      clientSecret: 'ding-client-secret',
      allowedUserIds: ['staff_1', 'staff_1'],
      cardTemplateId: 'template.schema',
    });
    store.setAdapterState(connection.id, 'dingtalk.reply:conversation_1', {
      sessionWebhook: 'https://secret.example/webhook',
      sourceMessageId: 'message_1',
      expiresAt: '2026-07-22T00:00:00.000Z',
    });

    assert.equal(JSON.stringify(connection).includes('ding-client-secret'), false);
    assert.deepEqual(connection.allowed_user_ids, ['staff_1']);
    assert.equal(connection.card_template_id, 'template.schema');
    const record = store.getConnection(connection.id)!;
    assert.equal(record.platform, 'dingtalk');
    assert.equal(store.getSecret(record.client_secret_ref), 'ding-client-secret');
    assert.deepEqual(store.getAdapterState(connection.id, 'dingtalk.reply:conversation_1'), {
      sessionWebhook: 'https://secret.example/webhook',
      sourceMessageId: 'message_1',
      expiresAt: '2026-07-22T00:00:00.000Z',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stores Feishu credentials outside public connection records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const connection = store.createFeishuConnection({
      name: 'Team Feishu',
      appId: 'cli_app_id',
      appSecret: 'feishu-app-secret',
      domain: 'lark',
    });

    assert.equal(connection.platform, 'feishu');
    assert.equal(connection.domain, 'lark');
    assert.equal(JSON.stringify(connection).includes('feishu-app-secret'), false);
    const record = store.getConnection(connection.id)!;
    assert.equal(record.platform, 'feishu');
    assert.equal(store.getSecret(record.app_secret_ref), 'feishu-app-secret');
    const verified = store.updateFeishuIdentity(connection.id, {
      openId: 'ou_bot',
      name: 'Moke Bot',
      avatarUrl: 'https://example.com/avatar.png',
    });
    assert.equal(verified.bot_open_id, 'ou_bot');
    assert.equal(verified.bot_name, 'Moke Bot');
    assert.equal(verified.bot_avatar_url, 'https://example.com/avatar.png');
    assert.ok(verified.verified_at);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manages all platforms through one connection index and removes connection-owned data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const storePath = join(directory, 'store');
    const store = new JsonMessagingStore(storePath);
    store.initialize();
    store.createConnection({
      name: '个人微信',
      ilinkBotId: 'bot@im.bot',
      apiBaseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'weixin-token',
    });
    const dingtalk = store.createDingTalkConnection({
      clientId: 'ding-client-id',
      clientSecret: 'ding-client-secret',
    });
    const feishu = store.createFeishuConnection({
      appId: 'cli_app_id',
      appSecret: 'feishu-app-secret',
    });
    store.setAdapterState(dingtalk.id, 'dingtalk.reply:conversation_1', { sessionWebhook: 'https://secret.example/webhook' });
    const binding = store.createBinding({
      connectionId: dingtalk.id,
      conversationId: 'conversation_1',
      sessionId: 'sess_dingtalk',
      platform: 'dingtalk',
    });
    store.enqueueInboundJob({ bindingId: binding.id, platformMessageId: 'queued_1', text: 'hello' });

    assert.deepEqual(store.listConnections().map((connection) => connection.platform).sort(), ['dingtalk', 'feishu', 'weixin']);
    assert.equal(store.setConnectionEnabled(dingtalk.id, false).enabled, false);
    assert.equal(store.updateConnectionState(dingtalk.id, { state: 'connected' }).state, 'connected');

    const messagingPath = join(storePath, 'messaging');
    const secretsBeforeDelete = readdirSync(join(messagingPath, 'secrets'));
    assert.equal(secretsBeforeDelete.length, 3);
    store.deleteConnection(dingtalk.id);

    assert.equal(store.getConnection(dingtalk.id), null);
    assert.equal(store.getBinding(binding.id), null);
    assert.equal(existsSync(join(messagingPath, 'connections', `${dingtalk.id}.json`)), false);
    assert.equal(existsSync(join(messagingPath, 'dingtalk', dingtalk.id)), false);
    assert.equal(existsSync(join(messagingPath, 'queues', `${binding.id}.json`)), false);
    assert.equal(readdirSync(join(messagingPath, 'secrets')).length, 2);
    store.deleteConnection(feishu.id);
    assert.equal(existsSync(join(messagingPath, 'feishu', feishu.id)), false);
    assert.equal(readdirSync(join(messagingPath, 'secrets')).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps dedupe and FIFO in one durable inbound job queue', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const binding = store.createBinding({
      connectionId: 'account_1',
      conversationId: 'conversation_1',
      conversationType: 'group',
      sessionId: 'sess_1',
      platform: 'dingtalk',
    });
    assert.equal(binding.conversation_type, 'group');
    const first = store.enqueueInboundJob({ bindingId: binding.id, platformMessageId: 'message_1', text: 'first' });
    const second = store.enqueueInboundJob({ bindingId: binding.id, platformMessageId: 'message_2', text: 'second' });
    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'queued');
    assert.equal(store.enqueueInboundJob({ bindingId: binding.id, platformMessageId: 'message_1', text: 'duplicate' }).status, 'duplicate');
    const active = store.claimNextInboundJob(binding.id)!;
    assert.equal(active.platform_message_id, 'message_1');
    assert.equal(store.claimNextInboundJob(binding.id), null);
    assert.equal(store.setInboundRun(binding.id, active.id, 'run_1'), true);
    assert.equal(store.markInboundDelivering(binding.id, active.id), true);
    assert.equal(store.completeInboundJob(binding.id, active.id), true);
    assert.equal(store.claimNextInboundJob(binding.id)?.platform_message_id, 'message_2');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails a running inbound job on restart without replaying its user message', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const binding = store.createBinding({ connectionId: 'account_1', conversationId: 'conversation_1', sessionId: 'sess_1' });
    const queued = store.enqueueInboundJob({ bindingId: binding.id, platformMessageId: 'message_1', text: 'first' });
    assert.equal(queued.status, 'queued');
    const active = store.claimNextInboundJob(binding.id)!;
    store.setInboundRun(binding.id, active.id, 'run_1');
    store.recoverInboundJobs();
    assert.equal(store.getInboundJob(binding.id, active.id)?.state, 'failed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates legacy pending queue entries without replaying the active item', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const storePath = join(directory, 'store');
    const store = new JsonMessagingStore(storePath);
    store.initialize();
    const binding = store.createBinding({ connectionId: 'account_1', conversationId: 'conversation_1', sessionId: 'sess_1' });
    const queuesPath = join(storePath, 'messaging', 'queues');
    mkdirSync(queuesPath, { recursive: true });
    writeFileSync(join(queuesPath, `${binding.id}.json`), JSON.stringify({
      active: { message_id: 'active_1', content: 'active', created_at: '2026-01-01T00:00:00.000Z', run_id: 'run_1' },
      pending: [{ message_id: 'pending_1', content: 'pending', created_at: '2026-01-01T00:01:00.000Z' }],
    }));
    store.initialize();
    assert.equal(store.claimNextInboundJob(binding.id)?.platform_message_id, 'pending_1');
    assert.equal(existsSync(join(queuesPath, `${binding.id}.json`)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persists unified outbound jobs with coalescing and content-safe idempotency', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const first = store.enqueueOutboundJob({
      idempotencyKey: 'run_1:status:1',
      bindingId: 'bind_1',
      coalesceKey: 'run_1:status',
      operation: { kind: 'status', phase: 'working', title: 'Working', detail: 'First' },
    });
    const second = store.enqueueOutboundJob({
      idempotencyKey: 'run_1:status:2',
      bindingId: 'bind_1',
      coalesceKey: 'run_1:status',
      operation: { kind: 'status', phase: 'working', title: 'Working', detail: 'Second' },
    });
    assert.equal(second.id, first.id);
    assert.equal(second.idempotency_key, 'run_1:status:2');
    assert.equal(store.claimDueOutboundJobs(1)[0]?.operation.kind, 'status');
    assert.throws(() => store.enqueueOutboundJob({
      idempotencyKey: 'run_1:status:2',
      bindingId: 'bind_1',
      operation: { kind: 'result', outcome: 'completed', text: 'different', message_already_delivered: false },
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('returns the earliest pending outbound attempt and ignores terminal or sending jobs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const operation = { kind: 'message' as const, contents: [{ type: 'text' as const, text: 'status' }] };

    const sending = store.enqueueOutboundJob({ idempotencyKey: 'sending', bindingId: 'bind_1', operation });
    store.claimDueOutboundJobs(1, '2099-01-01T00:00:00.000Z');
    assert.equal(store.getOutboundJob(sending.idempotency_key)?.state, 'sending');

    const delivered = store.enqueueOutboundJob({ idempotencyKey: 'delivered', bindingId: 'bind_1', operation: { ...operation, contents: [{ type: 'text', text: 'delivered' }] } });
    store.claimDueOutboundJobs(1, '2099-01-01T00:00:00.000Z');
    store.completeOutboundJob(delivered.id, { receipts: [] });

    const failed = store.enqueueOutboundJob({ idempotencyKey: 'failed', bindingId: 'bind_1', operation: { ...operation, contents: [{ type: 'text', text: 'failed' }] } });
    store.claimDueOutboundJobs(1, '2099-01-01T00:00:00.000Z');
    store.failOutboundJob(failed.id, 'permanent failure');

    const later = store.enqueueOutboundJob({ idempotencyKey: 'later', bindingId: 'bind_1', operation: { ...operation, contents: [{ type: 'text', text: 'later' }] } });
    store.retryOutboundJob(later.id, 'temporary failure', '2026-01-03T00:00:00.000Z');
    const earlier = store.enqueueOutboundJob({ idempotencyKey: 'earlier', bindingId: 'bind_1', operation: { ...operation, contents: [{ type: 'text', text: 'earlier' }] } });
    store.retryOutboundJob(earlier.id, 'temporary failure', '2026-01-02T00:00:00.000Z');

    assert.equal(store.getNextOutboundAttemptAt(), '2026-01-02T00:00:00.000Z');
    store.claimDueOutboundJobs(2, '2026-01-04T00:00:00.000Z');
    assert.equal(store.getNextOutboundAttemptAt(), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('terminal outbound state releases its inbound FIFO job in the store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const connection = store.createConnection({ name: 'WeChat', ilinkBotId: 'bot', apiBaseUrl: 'https://example.test', token: 'secret' });
    const binding = store.createBinding({ connectionId: connection.id, conversationId: 'user_1', sessionId: 'sess_1' });
    const inbound = store.enqueueInboundJob({ bindingId: binding.id, platformMessageId: 'msg_1', text: 'hello' });
    assert.equal(inbound.status, 'queued');
    const active = store.claimNextInboundJob(binding.id)!;
    store.setInboundRun(binding.id, active.id, 'run_1');
    store.markInboundDelivering(binding.id, active.id);
    const outbound = store.enqueueOutboundJob({
      idempotencyKey: 'run_1:result',
      bindingId: binding.id,
      inboundJobId: active.id,
      completesInbound: true,
      operation: { kind: 'result', outcome: 'completed', text: 'done', message_already_delivered: false },
    });
    store.claimDueOutboundJobs(1);
    const completed = store.completeOutboundJob(outbound.id, { receipts: [] });
    assert.equal(completed.releasedBindingId, binding.id);
    assert.equal(store.getInboundJob(binding.id, active.id)?.state, 'completed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reconciles a delivering inbound job after a crash between terminal writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const storePath = join(directory, 'store');
    const store = new JsonMessagingStore(storePath);
    store.initialize();
    const connection = store.createConnection({ name: 'WeChat', ilinkBotId: 'bot', apiBaseUrl: 'https://example.test', token: 'secret' });
    const binding = store.createBinding({ connectionId: connection.id, conversationId: 'user_1', sessionId: 'sess_1' });
    const inbound = store.enqueueInboundJob({ bindingId: binding.id, platformMessageId: 'msg_1', text: 'hello' });
    const active = store.claimNextInboundJob(binding.id)!;
    store.setInboundRun(binding.id, active.id, 'run_1');
    store.markInboundDelivering(binding.id, active.id);
    const outbound = store.enqueueOutboundJob({
      idempotencyKey: 'run_1:result', bindingId: binding.id, inboundJobId: active.id, completesInbound: true,
      operation: { kind: 'result', outcome: 'completed', text: 'done', message_already_delivered: false },
    });
    store.claimDueOutboundJobs(1);
    const outboundPath = join(storePath, 'messaging', 'outbound-jobs', `${outbound.id}.json`);
    writeFileSync(outboundPath, JSON.stringify({ ...outbound, state: 'delivered', receipts: [], updated_at: new Date().toISOString() }));
    store.recoverInboundJobs();
    assert.equal(store.getInboundJob(binding.id, active.id)?.state, 'completed');
    void inbound;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails a delivering inbound job when its final outbox job was never scheduled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const connection = store.createConnection({ name: 'WeChat', ilinkBotId: 'bot', apiBaseUrl: 'https://example.test', token: 'secret' });
    const binding = store.createBinding({ connectionId: connection.id, conversationId: 'user_1', sessionId: 'sess_1' });
    const inbound = store.enqueueInboundJob({ bindingId: binding.id, platformMessageId: 'msg_1', text: 'hello' });
    const active = store.claimNextInboundJob(binding.id)!;
    store.setInboundRun(binding.id, active.id, 'run_1');
    store.markInboundDelivering(binding.id, active.id);
    store.recoverInboundJobs();
    assert.equal(inbound.status, 'queued');
    assert.equal(store.getInboundJob(binding.id, active.id)?.state, 'failed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not replace a corrupted messaging JSON file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-messaging-store-'));
  try {
    const storePath = join(directory, 'store');
    const store = new JsonMessagingStore(storePath);
    store.initialize();
    const bindingsPath = join(storePath, 'messaging', 'bindings', 'index.json');
    writeFileSync(bindingsPath, '{broken');
    assert.throws(() => new JsonMessagingStore(storePath).initialize(), MessagingStoreCorruptionError);
    assert.equal(readFileSync(bindingsPath, 'utf8'), '{broken');
    writeFileSync(bindingsPath, '{}');
    assert.throws(() => new JsonMessagingStore(storePath).initialize(), MessagingStoreCorruptionError);
    assert.equal(readFileSync(bindingsPath, 'utf8'), '{}');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
