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
  markdown?: { text?: string };
  content?: unknown;
};

export type DingTalkNormalizedMessage = DingTalkRobotMessage & { imageData?: Uint8Array; fileName?: string };

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
  message: DingTalkNormalizedMessage;
}): DingTalkInboundMessage | null {
  const conversationId = input.message.conversationId?.trim() || '';
  const messageId = input.message.msgId?.trim() || input.eventId?.trim() || '';
  const senderId = input.message.senderStaffId?.trim() || input.message.senderId?.trim() || '';
  const text = extractText(input.message);
  const fileText = input.message.fileName ? `[File: ${input.message.fileName}]` : '';
  if (!conversationId || !messageId || !senderId || (!text && !fileText && !input.message.imageData)) return null;

  const occurredAt = Number.isFinite(input.message.createAt)
    ? new Date(input.message.createAt as number).toISOString()
    : new Date().toISOString();
  const event: MessagingInboundEvent = {
    id: `dingtalk:${input.accountId}:${input.eventId?.trim() || messageId}`,
    platform: 'dingtalk',
    account_id: input.accountId,
    conversation: { id: conversationId, type: toConversationType(input.message.conversationType) },
    sender: { id: senderId, ...(input.message.senderNick?.trim() ? { display_name: input.message.senderNick.trim() } : {}) },
    message: {
      id: messageId,
      segments: [
        ...(text || fileText ? [{ type: 'text' as const, text: [text, fileText].filter(Boolean).join('\n') }] : []),
        ...(input.message.imageData ? [{ type: 'image' as const, data: input.message.imageData, name: `dingtalk-${messageId}` }] : []),
      ],
    },
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

export function extractDingTalkMedia(message: DingTalkRobotMessage) {
  const content = contentObject(message.content);
  if (message.msgtype === 'picture') {
    const url = readString(content?.pictureUrl);
    const downloadCode = readString(content?.downloadCode);
    return url || downloadCode ? [{ kind: 'image' as const, url, downloadCode }] : [];
  }
  if (message.msgtype === 'file') {
    const downloadCode = readString(content?.downloadCode);
    return downloadCode ? [{ kind: 'file' as const, downloadCode, fileName: readString(content?.fileName) || 'dingtalk-file' }] : [];
  }
  if (message.msgtype !== 'richText' || !Array.isArray(content?.richText)) return [];
  return content.richText.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const url = readString(record.pictureUrl);
    const downloadCode = readString(record.downloadCode);
    return url || downloadCode ? [{ kind: 'image' as const, url, downloadCode }] : [];
  });
}

function extractText(message: DingTalkRobotMessage) {
  if (typeof message.text?.content === 'string') return message.text.content.trim();
  if (typeof message.markdown?.text === 'string') return message.markdown.text.trim();
  const content = contentObject(message.content);
  if (typeof content?.text === 'string') return content.text.trim();
  return '';
}

function contentObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object') return value as Record<string, any>;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toConversationType(value: DingTalkRobotMessage['conversationType']) {
  return value === 2 || value === '2' || value === 'group' ? 'group' as const : 'direct' as const;
}

function toIsoDate(value: number | undefined) {
  return Number.isFinite(value) ? new Date(value as number).toISOString() : undefined;
}
