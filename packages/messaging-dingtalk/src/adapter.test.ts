import assert from 'node:assert/strict';
import test from 'node:test';
import { DingTalkAdapter } from './adapter.js';

test('sends text only through the saved current DingTalk session webhook', async () => {
  let body = '';
  const adapter = new DingTalkAdapter({
    accountId: 'dtconn_1', clientId: 'id', clientSecret: 'secret', saveReplyContext: async () => undefined,
    loadReplyContext: () => ({ sessionWebhook: 'https://example.test/webhook' }),
    fetcher: async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    },
  });
  await adapter.sendText('conversation_1', 'hello');
  assert.deepEqual(JSON.parse(body), { msgtype: 'text', text: { content: 'hello' } });
});
