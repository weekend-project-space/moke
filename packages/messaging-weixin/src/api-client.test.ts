import assert from 'node:assert/strict';
import test from 'node:test';

import { WeixinApiClient } from './api-client.js';

const baseInfo = { channel_version: '0.1.0', bot_agent: 'Moke/0.1.0' };

test('getUpdates sends authenticated protocol headers and cursor', async () => {
  let received: RequestInit | undefined;
  const client = new WeixinApiClient({
    token: 'token-value',
    fetch: (async (_input, init) => {
      received = init;
      return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'next' }));
    }) as typeof fetch,
  });

  const result = await client.getUpdates('previous');
  assert.equal(result.get_updates_buf, 'next');
  assert.equal((received?.headers as Record<string, string>).Authorization, 'Bearer token-value');
  assert.equal((received?.headers as Record<string, string>).AuthorizationType, 'ilink_bot_token');
  assert.deepEqual(JSON.parse(String(received?.body)), { get_updates_buf: 'previous', base_info: baseInfo });
});

test('rejects non-HTTPS custom API URLs before sending a credential', async () => {
  const client = new WeixinApiClient({ token: 'token-value', baseUrl: 'http://127.0.0.1:4010' });
  await assert.rejects(() => client.getUpdates(''), /HTTPS/);
});

test('sendText sends a completed bot message in the Weixin protocol shape', async () => {
  let received: RequestInit | undefined;
  const client = new WeixinApiClient({
    token: 'token-value',
    fetch: (async (_input, init) => {
      received = init;
      return new Response('{}');
    }) as typeof fetch,
  });

  await client.sendText({ toUserId: 'user@im.wechat', contextToken: 'context', text: 'Hello' });

  const body = JSON.parse(String(received?.body));
  assert.deepEqual(body.msg, {
    from_user_id: '',
    to_user_id: 'user@im.wechat',
    client_id: body.msg.client_id,
    message_type: 2,
    message_state: 2,
    context_token: 'context',
    item_list: [{ type: 1, text_item: { text: 'Hello' } }],
  });
  assert.match(body.msg.client_id, /^moke-[0-9a-f-]{36}$/);
});

test('getConfig and sendTyping use the contact context and typing ticket', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = new WeixinApiClient({
    token: 'token-value',
    fetch: (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(requests.length === 1 ? { ret: 0, typing_ticket: 'ticket' } : { ret: 0 }));
    }) as typeof fetch,
  });

  const config = await client.getConfig({ userId: 'user@im.wechat', contextToken: 'context' });
  await client.sendTypingWithTicket({ userId: 'user@im.wechat', typingTicket: config.typing_ticket || '', status: 1 });

  assert.match(requests[0]?.url || '', /ilink\/bot\/getconfig$/);
  assert.deepEqual(requests[0]?.body, {
    ilink_user_id: 'user@im.wechat',
    context_token: 'context',
    base_info: baseInfo,
  });
  assert.match(requests[1]?.url || '', /ilink\/bot\/sendtyping$/);
  assert.deepEqual(requests[1]?.body, {
    ilink_user_id: 'user@im.wechat',
    typing_ticket: 'ticket',
    status: 1,
    base_info: baseInfo,
  });
});

test('sendTyping rejects a non-zero Weixin response', async () => {
  const client = new WeixinApiClient({
    token: 'token-value',
    fetch: (async () => new Response(JSON.stringify({ ret: 12, errmsg: 'expired ticket' }))) as typeof fetch,
  });
  await assert.rejects(
    () => client.sendTypingWithTicket({ userId: 'user@im.wechat', typingTicket: 'ticket', status: 1 }),
    /expired ticket/,
  );
});
