import type { MessagingCapabilities } from '@moke/messaging-core';

export const FEISHU_TEXT_LIMIT = 30_000;

export const feishuCapabilities: MessagingCapabilities = {
  direct: true,
  group: true,
  proactive: 'all',
  edit_message: false,
  streaming_update: false,
  buttons: false,
  markdown: true,
  image: false,
  file: false,
  audio_receive: false,
  video_receive: false,
  typing: false,
  quote: true,
  max_text_length: FEISHU_TEXT_LIMIT,
};
