import type { MessagingCapability } from '@moke/messaging-core';

export const FEISHU_TEXT_LIMIT = 30_000;

export const feishuCapabilities: ReadonlySet<MessagingCapability> = new Set([
  'receive.text',
  'receive.image',
  'send.text',
  'send.image',
  'send.file',
  'status',
  'interaction',
]);
