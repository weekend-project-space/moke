import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import test from 'node:test';

import { downloadWeixinImage } from './media.js';
import { WeixinApiError } from './api-client.js';
import { uploadWeixinMedia } from './outbound-media.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2kAAAAASUVORK5CYII=', 'base64');

test('downloads and decrypts a Weixin image', async () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(PNG), cipher.final()]);
  const image = await downloadWeixinImage({
    downloadUrl: 'https://mmbiz.qpic.cn/example.png',
    aesKey: key.toString('base64'),
  }, async () => new Response(encrypted));
  assert.deepEqual(image, PNG);
});

test('rejects untrusted Weixin image hosts', async () => {
  await assert.rejects(
    () => downloadWeixinImage({ downloadUrl: 'https://example.test/image.png' }, async () => new Response(PNG)),
    /not trusted/,
  );
});

test('retries a transient CDN upload failure before sending media', async () => {
  let uploads = 0;
  const client = {
    async getUploadUrl() {
      return { upload_full_url: 'https://mmbiz.qpic.cn/upload' };
    },
    async uploadCdn() {
      uploads += 1;
      if (uploads < 3) throw new WeixinApiError('WEIXIN_CDN_UPLOAD_FAILED', 'temporary', true);
      return 'encrypted-query-param';
    },
  };

  const output = await uploadWeixinMedia({
    client: client as never,
    toUserId: 'user@im.wechat',
    media: { type: 'image', data: PNG, name: 'image.png', mimeType: 'image/png' },
  });

  assert.equal(uploads, 3);
  assert.equal(output.item.type, 2);
});
