import assert from 'node:assert/strict';
import test from 'node:test';

import { renderWeixinQrCode } from './weixin-login-service.js';

test('renders Weixin QR content as a local PNG data URL', async () => {
  const image = await renderWeixinQrCode('https://example.test/weixin-auth?ticket=abc');
  assert.match(image, /^data:image\/png;base64,/);
});

test('rejects an empty Weixin QR payload', () => {
  assert.throws(() => renderWeixinQrCode('  '), /QR code content is empty/);
});
