import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFeishuIdentity } from './adapter.js';

test('resolves and normalizes the Feishu bot identity', async () => {
  const identity = await resolveFeishuIdentity({
    request: async () => ({ bot: { open_id: 'ou_bot', app_name: 'Moke Bot', avatar_url: 'https://example.test/avatar.png' } }),
  } as never);
  assert.deepEqual(identity, {
    openId: 'ou_bot',
    name: 'Moke Bot',
    avatarUrl: 'https://example.test/avatar.png',
  });
});

test('rejects credentials that cannot resolve a Feishu bot', async () => {
  await assert.rejects(
    () => resolveFeishuIdentity({ request: async () => ({}) } as never),
    /bot is not enabled/,
  );
});
