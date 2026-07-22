import type { MessagingInboundEvent } from '@moke/messaging-core';

export type DingTalkRobotMessage = {
  conversationId?: string;
  conversationType?: string | number;
  msgId?: string;
  senderNick?: string;
  senderId?: string;
  senderStaffId?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  createAt?: number;
  msgtype?: string;
  text?: { content?: string };
};

export type DingTalkReplyContext = {
  conversationId: string;
  sessionWebhook: string;
  expiresAt?: string;
  sourceMessageId: string;
};

export type DingTalkInboundMessage = {
  event: MessagingInboundEvent;
  replyContext?: DingTalkReplyContext;
};

/** Converts only public message semantics; reply credentials stay adapter-private. */
export function toDingTalkInboundMessage(input: {
  accountId: string;
  eventId?: string;
  message: DingTalkRobotMessage;
}): DingTalkInboundMessage | null {
  const conversationId = input.message.conversationId?.trim() || '';
  const messageId = input.message.msgId?.trim() || input.eventId?.trim() || '';
  const senderId = input.message.senderId?.trim() || input.message.senderStaffId?.trim() || '';
  const text = input.message.msgtype === 'text' ? input.message.text?.content?.trim() || '' : '';
  if (!conversationId || !messageId || !senderId || !text) return null;

  const occurredAt = Number.isFinite(input.message.createAt)
    ? new Date(input.message.createAt as number).toISOString()
    : new Date().toISOString();
  const event: MessagingInboundEvent = {
    id: `dingtalk:${input.accountId}:${input.eventId?.trim() || messageId}`,
    platform: 'dingtalk',
    account_id: input.accountId,
    conversation: { id: conversationId, type: toConversationType(input.message.conversationType) },
    sender: { id: senderId, ...(input.message.senderNick?.trim() ? { display_name: input.message.senderNick.trim() } : {}) },
    message: { id: messageId, segments: [{ type: 'text', text }] },
    occurred_at: occurredAt,
  };
  const webhook = input.message.sessionWebhook?.trim();
  return {
    event,
    ...(webhook ? {
      replyContext: {
        conversationId,
        sessionWebhook: webhook,
        sourceMessageId: messageId,
        ...(toIsoDate(input.message.sessionWebhookExpiredTime) ? { expiresAt: toIsoDate(input.message.sessionWebhookExpiredTime) } : {}),
      },
    } : {}),
  };
}

function toConversationType(value: DingTalkRobotMessage['conversationType']) {
  return value === 2 || value === '2' || value === 'group' ? 'group' as const : 'direct' as const;
}

function toIsoDate(value: number | undefined) {
  return Number.isFinite(value) ? new Date(value as number).toISOString() : undefined;
}
