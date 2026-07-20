import assert from 'node:assert/strict';
import test from 'node:test';

import { splitWeixinText, toMessagingInboundEvent } from './message-converter.js';

test('converts a Weixin text message into an account-scoped inbound event', () => {
  const event = toMessagingInboundEvent({
    accountId: 'wxconn_a',
    botUserId: 'bot@im.bot',
    message: {
      message_id: 42,
      from_user_id: 'user@im.wechat',
      create_time_ms: 1_700_000_000_000,
      context_token: 'secret-context',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    },
  });

  assert.deepEqual(event, {
    id: 'weixin:wxconn_a:42',
    platform: 'weixin',
    account_id: 'wxconn_a',
    conversation: { id: 'user@im.wechat', type: 'direct' },
    sender: { id: 'user@im.wechat' },
    message: { id: '42', segments: [{ type: 'text', text: '你好' }] },
    occurred_at: '2023-11-14T22:13:20.000Z',
    context_token: 'secret-context',
  });
});

test('ignores messages sent by the connected bot and messages without text', () => {
  assert.equal(toMessagingInboundEvent({
    accountId: 'wxconn_a',
    botUserId: 'bot@im.bot',
    message: { message_id: 1, from_user_id: 'bot@im.bot', item_list: [{ text_item: { text: 'echo' } }] },
  }), null);
  assert.equal(toMessagingInboundEvent({
    accountId: 'wxconn_a',
    message: { message_id: 2, from_user_id: 'user@im.wechat', item_list: [] },
  }), null);
});

test('converts an image message into an image segment', () => {
  const event = toMessagingInboundEvent({
    accountId: 'wxconn_a',
    message: {
      message_id: 3,
      from_user_id: 'user@im.wechat',
      item_list: [{
        type: 2,
        image_item: {
          aeskey: '00112233445566778899aabbccddeeff',
          media: {
            full_url: 'https://mmbiz.qpic.cn/example.png',
            encrypt_query_param: 'encrypted',
            aes_key: 'key',
          },
        },
      }],
    },
  });

  assert.equal(event?.message.segments[0]?.type, 'image');
  assert.deepEqual(event?.message.segments[0], {
    type: 'image',
    download_url: 'https://mmbiz.qpic.cn/example.png',
    encrypted_query_param: 'encrypted',
    aes_key: 'key',
    aeskey: '00112233445566778899aabbccddeeff',
  });
});

test('converts an encrypted-query-only image message', () => {
  const event = toMessagingInboundEvent({
    accountId: 'wxconn_a',
    message: {
      message_id: 4,
      from_user_id: 'user@im.wechat',
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'encrypted' } } }],
    },
  });
  assert.deepEqual(event?.message.segments, [{ type: 'image', encrypted_query_param: 'encrypted' }]);
});

test('splits text without breaking Unicode characters', () => {
  assert.deepEqual(splitWeixinText('甲乙\n丙丁戊', 3), ['甲乙', '丙丁戊']);
  assert.deepEqual(splitWeixinText('🙂🙂🙂', 2), ['🙂🙂', '🙂']);
});
