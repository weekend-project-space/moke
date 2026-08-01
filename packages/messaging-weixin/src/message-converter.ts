import type { MessageSegment, MessagingInboundEvent } from '@moke/messaging-core';
import type { WeixinInboundMessage } from './api-client.js';

export function toMessagingInboundEvent(input: {
  accountId: string;
  botUserId?: string;
  message: WeixinInboundMessage;
}): MessagingInboundEvent | null {
  const { message } = input;
  const messageId = message.message_id === undefined ? '' : String(message.message_id);
  const peerUserId = message.from_user_id?.trim() || '';
  if (!messageId || !peerUserId) return null;
  if (input.botUserId && peerUserId === input.botUserId) return null;

  const segments: MessageSegment[] = (message.item_list || []).flatMap<MessageSegment>((item) => {
    const text = item.text_item?.text?.trim();
    if (text) return [{ type: 'text' as const, text }];
    const image = item.image_item;
    const downloadUrl = image?.media?.full_url || image?.url || '';
    if (item.type === 2 && (downloadUrl || image?.media?.encrypt_query_param)) {
      return [{
        type: 'image' as const,
        ...(downloadUrl ? { download_url: downloadUrl } : {}),
        ...(image?.media?.encrypt_query_param ? { encrypted_query_param: image.media.encrypt_query_param } : {}),
        ...(image?.media?.aes_key ? { aes_key: image.media.aes_key } : {}),
        ...(image?.aeskey ? { aeskey: image.aeskey } : {}),
      }];
    }
    const quoteId = item.ref_msg?.message_id === undefined ? '' : String(item.ref_msg.message_id);
    if (quoteId) return [{ type: 'quote' as const, message_id: quoteId, text: item.ref_msg?.text }];
    return [];
  });
  if (!segments.some((segment) => segment.type === 'text' || segment.type === 'image')) return null;

  const occurredAt = Number.isFinite(message.create_time_ms)
    ? new Date(message.create_time_ms as number).toISOString()
    : new Date().toISOString();
  return {
    id: `weixin:${input.accountId}:${messageId}`,
    platform: 'weixin',
    account_id: input.accountId,
    conversation: { id: peerUserId, type: 'direct' },
    sender: { id: peerUserId },
    message: { id: messageId, segments },
    occurred_at: occurredAt,
    ...(message.context_token ? { context_token: message.context_token } : {}),
  };
}

export function splitWeixinText(text: string, limit: number) {
  const normalized = text.trim();
  if (!normalized) return [];
  const characters = Array.from(normalized);
  const parts: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + limit, characters.length);
    if (end < characters.length) {
      const paragraphBreak = characters.slice(start, end).lastIndexOf('\n');
      if (paragraphBreak >= Math.floor(limit / 2)) end = start + paragraphBreak + 1;
    }
    parts.push(characters.slice(start, end).join('').trim());
    start = end;
  }
  return parts.filter(Boolean);
}
