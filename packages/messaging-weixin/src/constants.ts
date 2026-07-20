import type { MessagingCapabilities } from '@moke/messaging-core';

export const WEIXIN_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const WEIXIN_BOT_TYPE = '3';
export const WEIXIN_CHANNEL_VERSION = '0.1.0';
export const WEIXIN_BOT_AGENT = 'Moke/0.1.0';
export const WEIXIN_LONG_POLL_TIMEOUT_MS = 35_000;
export const WEIXIN_TEXT_LIMIT = 2_000;

export const weixinCapabilities: MessagingCapabilities = {
  direct: true,
  group: false,
  proactive: 'recent-contact-only',
  edit_message: false,
  streaming_update: false,
  buttons: false,
  markdown: false,
  image: true,
  file: false,
  audio_receive: false,
  video_receive: false,
  typing: true,
  quote: true,
  max_text_length: WEIXIN_TEXT_LIMIT,
};
