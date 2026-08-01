import assert from 'node:assert/strict';
import test from 'node:test';

import { toFeishuInboundEvent } from './message-converter.js';

test('converts a Feishu group message into a messaging event', () => {
  const event = toFeishuInboundEvent({
    accountId: 'fsconn_1',
    receivedAt: Date.parse('2026-07-23T00:00:00.000Z'),
    message: {
      content: ' hello ',
      senderId: 'ou_sender',
      senderName: 'Alice',
      chatId: 'oc_chat',
      chatType: 'group',
      messageId: 'om_message',
    },
  });

  assert.deepEqual(event, {
    id: 'feishu:fsconn_1:om_message',
    platform: 'feishu',
    account_id: 'fsconn_1',
    conversation: { id: 'oc_chat', type: 'group' },
    sender: { id: 'ou_sender', display_name: 'Alice' },
    message: { id: 'om_message', segments: [{ type: 'text', text: 'hello' }] },
    occurred_at: '2026-07-23T00:00:00.000Z',
  });
});

test('ignores incomplete Feishu messages', () => {
  assert.equal(toFeishuInboundEvent({
    accountId: 'fsconn_1',
    message: { content: '', senderId: 'ou_sender', chatId: 'oc_chat', messageId: 'om_message' },
  }), null);
});

test('converts a downloaded Feishu image into an image segment', () => {
  const data = new Uint8Array([1, 2, 3]);
  const event = toFeishuInboundEvent({
    accountId: 'fsconn_1',
    message: {
      content: '',
      senderId: 'ou_sender',
      chatId: 'oc_chat',
      messageId: 'om_image',
      imageData: data,
    },
  });

  assert.deepEqual(event?.message.segments, [{ type: 'image', data, name: 'feishu-om_image' }]);
});
