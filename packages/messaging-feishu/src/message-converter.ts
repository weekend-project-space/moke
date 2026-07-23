import type { MessagingInboundEvent } from '@moke/messaging-core';

export type FeishuNormalizedMessage = {
  content: string;
  senderId?: string;
  senderName?: string;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  imageData?: Uint8Array;
};

export function toFeishuInboundEvent(input: {
  accountId: string;
  message: FeishuNormalizedMessage;
  receivedAt?: number;
}): MessagingInboundEvent | null {
  const text = input.message.content.trim();
  const senderId = input.message.senderId?.trim() || '';
  const conversationId = input.message.chatId?.trim() || '';
  const messageId = input.message.messageId?.trim() || '';
  if ((!text && !input.message.imageData) || !senderId || !conversationId || !messageId) return null;

  const occurredAt = new Date(input.receivedAt ?? Date.now()).toISOString();
  return {
    id: `feishu:${input.accountId}:${messageId}`,
    platform: 'feishu',
    account_id: input.accountId,
    conversation: {
      id: conversationId,
      type: input.message.chatType === 'group' ? 'group' : 'direct',
    },
    sender: {
      id: senderId,
      ...(input.message.senderName?.trim() ? { display_name: input.message.senderName.trim() } : {}),
    },
    message: {
      id: messageId,
      segments: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...(input.message.imageData ? [{ type: 'image' as const, data: input.message.imageData, name: `feishu-${messageId}` }] : []),
      ],
    },
    occurred_at: occurredAt,
  };
}
