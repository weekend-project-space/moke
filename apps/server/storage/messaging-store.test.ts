import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
