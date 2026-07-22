import assert from 'node:assert/strict';
import test from 'node:test';

import { toDingTalkInboundMessage } from './message-converter.js';

test('converts a DingTalk text event while keeping the reply webhook private', () => {
  const inbound = toDingTalkInboundMessage({
    accountId: 'dtconn_1',
    eventId: 'event_1',
    message: {
      conversationId: 'cid_1',
      conversationType: '2',
      msgId: 'msg_1',
      createAt: 1_768_000_000_000,
      senderId: 'user_1',
      senderNick: 'Ada',
      msgtype: 'text',
      text: { content: ' hello ' },
      sessionWebhook: 'https://secret.example/webhook',
      sessionWebhookExpiredTime: 1_768_000_000_000,
    },
  });

  assert.deepEqual(inbound?.event, {
    id: 'dingtalk:dtconn_1:event_1',
    platform: 'dingtalk',
    account_id: 'dtconn_1',
    conversation: { id: 'cid_1', type: 'group' },
    sender: { id: 'user_1', display_name: 'Ada' },
    message: { id: 'msg_1', segments: [{ type: 'text', text: 'hello' }] },
    occurred_at: new Date(1_768_000_000_000).toISOString(),
  });
  assert.equal(inbound?.replyContext?.sessionWebhook, 'https://secret.example/webhook');
  assert.equal(JSON.stringify(inbound?.event).includes('secret.example'), false);
});

test('ignores unsupported DingTalk messages', () => {
  assert.equal(toDingTalkInboundMessage({
    accountId: 'dtconn_1',
    message: { conversationId: 'cid_1', msgId: 'msg_1', senderId: 'user_1', msgtype: 'picture' },
  }), null);
});
