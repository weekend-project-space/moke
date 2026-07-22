import type { MessagingCapabilities } from '@moke/messaging-core';

export const DINGTALK_TEXT_LIMIT = 2_000;

export const dingtalkCapabilities: MessagingCapabilities = {
  direct: true,
  group: true,
  proactive: 'none',
  edit_message: false,
  streaming_update: false,
  buttons: false,
  markdown: false,
  image: true,
  file: true,
  audio_receive: false,
  video_receive: false,
  typing: false,
  quote: false,
  max_text_length: DINGTALK_TEXT_LIMIT,
};
