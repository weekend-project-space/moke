import assert from 'node:assert/strict';
import test from 'node:test';
import { DingTalkAdapter } from './adapter.js';

test('sends text only through the saved current DingTalk session webhook', async () => {
  let body = '';
  let tokenRequests = 0;
  let authorization = '';
  const adapter = new DingTalkAdapter({
    accountId: 'dtconn_1', clientId: 'id', clientSecret: 'secret', saveReplyContext: async () => undefined,
    loadReplyContext: () => ({ sessionWebhook: 'https://example.test/webhook' }),
    fetcher: async (url, init) => {
      if (String(url).endsWith('/oauth2/accessToken')) {
        tokenRequests += 1;
        return new Response(JSON.stringify({ accessToken: 'token', expireIn: 7200 }), { status: 200 });
      }
      body = String(init?.body);
      authorization = String((init?.headers as Record<string, string>)?.['x-acs-dingtalk-access-token']);
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    },
  });
  await adapter.sendText('conversation_1', 'hello');
  await adapter.sendText('conversation_1', 'again');
  assert.deepEqual(JSON.parse(body), { msgtype: 'markdown', markdown: { title: 'Moke', text: 'again' } });
  assert.equal(authorization, 'token');
  assert.equal(tokenRequests, 1);
});
