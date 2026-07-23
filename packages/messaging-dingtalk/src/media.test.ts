import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadDingTalkImage } from './media.js';

test('downloads a DingTalk image through a resolved download code', async () => {
  const requests: string[] = [];
  const data = await downloadDingTalkImage({
    candidate: { kind: 'image', downloadCode: 'code' },
    robotCode: 'robot',
    accessToken: 'token',
    fetcher: async (url) => {
      requests.push(String(url));
      return String(url).includes('/messageFiles/download')
        ? new Response(JSON.stringify({ downloadUrl: 'https://cdn.example.test/image.png' }), { status: 200 })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    },
  });

  assert.deepEqual(data, Buffer.from([1, 2, 3]));
  assert.equal(requests.length, 2);
});

test('rejects untrusted DingTalk image URLs', async () => {
  await assert.rejects(() => downloadDingTalkImage({
    candidate: { kind: 'image', url: 'http://127.0.0.1/private' },
    robotCode: 'robot',
    accessToken: 'token',
  }), /not trusted/);
});
