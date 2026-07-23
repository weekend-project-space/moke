import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonMessagingStore } from './messaging-store.js';

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
    assert.equal(store.getToken(connection), 'bot-token');
    store.saveContextToken({ connectionId: connection.id, peerUserId: 'user@im.wechat', token: 'context-token', messageId: '1' });
    assert.equal(store.getContextToken(connection.id, 'user@im.wechat'), 'context-token');

    const binding = store.createBinding({ connectionId: connection.id, conversationId: 'user@im.wechat', sessionId: 'sess_1' });
    assert.equal(store.getBinding(binding.id)?.session_id, 'sess_1');
    store.markBindingInbound(binding.id, 'message_0', 'user@im.wechat');
    assert.equal(store.getBinding(binding.id)?.last_sender_id, 'user@im.wechat');
    assert.equal(store.claimInbound(connection.id, 'message_1'), 'claimed');
    store.completeInbound(connection.id, 'message_1');
    assert.equal(store.claimInbound(connection.id, 'message_1'), 'duplicate');

    store.enqueueInbound(binding.id, { message_id: 'queued_1', content: 'first' });
    store.enqueueInbound(binding.id, { message_id: 'queued_2', content: 'second' });
    assert.equal(store.claimNextQueued(binding.id)?.message_id, 'queued_1');
    assert.equal(store.setQueuedRun(binding.id, 'queued_1', 'run_1'), true);
    assert.equal(store.claimNextQueued(binding.id), null);
    assert.equal(store.completeQueuedRun(binding.id, 'run_1'), true);
    assert.equal(store.claimNextQueued(binding.id)?.message_id, 'queued_2');
    assert.equal(store.discardQueuedMessage(binding.id, 'queued_2'), true);
    store.enqueueInbound(binding.id, { message_id: 'queued_3', content: 'third' });
    assert.deepEqual(store.recoverQueuedBindings(), [binding.id]);
    assert.equal(store.claimNextQueued(binding.id)?.message_id, 'queued_3');

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
    store.saveDingTalkReplyContext({
      connectionId: connection.id,
      conversationId: 'conversation_1',
      sessionWebhook: 'https://secret.example/webhook',
      sourceMessageId: 'message_1',
      expiresAt: '2026-07-22T00:00:00.000Z',
    });

    assert.equal(JSON.stringify(connection).includes('ding-client-secret'), false);
    assert.deepEqual(connection.allowed_user_ids, ['staff_1']);
    assert.equal(connection.card_template_id, 'template.schema');
    assert.equal(store.getDingTalkClientSecret(store.getDingTalkConnection(connection.id)!), 'ding-client-secret');
    assert.deepEqual(store.getDingTalkReplyContext(connection.id, 'conversation_1'), {
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
    assert.equal(store.getFeishuAppSecret(store.getFeishuConnection(connection.id)!), 'feishu-app-secret');
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
    store.saveDingTalkReplyContext({
      connectionId: dingtalk.id,
      conversationId: 'conversation_1',
      sessionWebhook: 'https://secret.example/webhook',
      sourceMessageId: 'message_1',
    });
    const binding = store.createBinding({
      connectionId: dingtalk.id,
      conversationId: 'conversation_1',
      sessionId: 'sess_dingtalk',
      platform: 'dingtalk',
    });
    store.enqueueInbound(binding.id, { message_id: 'queued_1', content: 'hello' });

    assert.deepEqual(store.listConnections().map((connection) => connection.platform).sort(), ['dingtalk', 'feishu', 'weixin']);
    assert.equal(store.setConnectionEnabled(dingtalk.id, false).enabled, false);
    assert.equal(store.updateConnectionState(dingtalk.id, { state: 'connected' }).state, 'connected');

    const messagingPath = join(storePath, 'messaging');
    const secretsBeforeDelete = readdirSync(join(messagingPath, 'secrets'));
    assert.equal(secretsBeforeDelete.length, 4);
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
