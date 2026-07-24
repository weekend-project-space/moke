import type { MessagingCapability } from '@moke/messaging-core';

export const DINGTALK_TEXT_LIMIT = 2_000;

export const dingtalkCapabilities: ReadonlySet<MessagingCapability> = new Set([
  'receive.text',
  'receive.image',
  'send.text',
  'status',
]);
