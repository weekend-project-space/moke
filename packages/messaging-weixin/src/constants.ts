import type { MessagingCapability } from '@moke/messaging-core';

export const WEIXIN_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const WEIXIN_BOT_TYPE = '3';
// Match the media-capable iLink protocol client used by Tencent's adapter.
export const WEIXIN_CHANNEL_VERSION = '2.4.6';
export const WEIXIN_BOT_AGENT = 'OpenClaw';
export const WEIXIN_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
export const WEIXIN_LONG_POLL_TIMEOUT_MS = 35_000;
export const WEIXIN_TEXT_LIMIT = 2_000;

export const weixinCapabilities: ReadonlySet<MessagingCapability> = new Set([
  'receive.text',
  'receive.image',
  'send.text',
  'send.image',
  'send.file',
  'activity',
]);
