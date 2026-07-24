import { MessagingDeliveryError, splitMessagingText } from '@moke/messaging-core';
import type {
  AdapterContext,
  AdapterStatus,
  DeliveryReceipt,
  MessagingAdapter,
  MessagingDeliveryResult,
  MessagingDeliveryTarget,
  MessagingOutboundOperation,
  MessagingTarget,
  OutboundMessage,
} from '@moke/messaging-core';
import { WEIXIN_LONG_POLL_TIMEOUT_MS, WEIXIN_TEXT_LIMIT } from './constants.js';
import { WeixinApiClient, WeixinApiError } from './api-client.js';
import { uploadWeixinMedia, type WeixinOutboundMedia } from './outbound-media.js';
import { toMessagingInboundEvent } from './message-converter.js';
import { weixinCapabilities } from './constants.js';
import { downloadWeixinImage } from './media.js';

export type WeixinAdapterConfig = {
  accountId: string;
  botUserId?: string;
  token: string;
  baseUrl?: string;
  client?: WeixinApiClient;
};

export class WeixinAdapter implements MessagingAdapter {
  readonly platform = 'weixin' as const;
  readonly capabilities = weixinCapabilities;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private status: AdapterStatus = { state: 'stopped', changed_at: new Date().toISOString() };
  private context: AdapterContext | undefined;
  private readonly typingTickets = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly config: WeixinAdapterConfig) {}

  async start(context: AdapterContext) {
    if (this.loop) return;
    this.context = context;
    this.controller = new AbortController();
    this.setStatus(context, { state: 'starting', changed_at: new Date().toISOString() });
    this.loop = this.poll(context, this.controller.signal).finally(() => {
      this.loop = undefined;
      this.controller = undefined;
    });
    await Promise.resolve();
  }

  async stop(reason: 'user' | 'shutdown' | 'reauth' | 'error') {
    this.controller?.abort();
    await this.loop;
    if (this.status.state !== 'reauth_required' && this.status.state !== 'error') {
      this.status = { state: 'stopped', changed_at: new Date().toISOString() };
    }
    this.context = undefined;
    void reason;
  }

  getStatus() {
    return this.status;
  }

  async deliver(
    target: MessagingDeliveryTarget,
    operation: MessagingOutboundOperation,
    previousReference?: Record<string, string>,
  ): Promise<MessagingDeliveryResult> {
    const contextToken = this.context?.state.get<string>(`weixin.context:${target.conversation.id}`);
    const legacyTarget: MessagingTarget = {
      account_id: target.account_id,
      conversation_id: target.conversation.id,
      ...(contextToken ? { context_token: contextToken } : {}),
    };

    if (operation.kind === 'activity') {
      await this.setTyping(legacyTarget, operation.active ? 1 : 2);
      return { receipts: [], ...(previousReference ? { reference: previousReference } : {}) };
    }
    if (operation.kind === 'status') {
      return { receipts: [], ...(previousReference ? { reference: previousReference } : {}) };
    }
    if (operation.kind === 'interaction') {
      const text = operation.resolved
        ? `${operation.detail}\n\n${operation.resolved.label}`
        : `${operation.title}\n\n${operation.detail}\n\n${operation.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}\n\nOpen Moke to respond.`;
      const receipts = [];
      for (const part of splitMessagingText(text, WEIXIN_TEXT_LIMIT)) receipts.push({ type: 'text' as const, ...(await this.send(legacyTarget, { text: part })) });
      return { receipts };
    }
    if (operation.kind === 'result') {
      if (operation.message_already_delivered) return { receipts: [], ...(previousReference ? { reference: previousReference } : {}) };
      const receipts = [];
      for (const part of splitMessagingText(operation.text, WEIXIN_TEXT_LIMIT)) receipts.push({ type: 'text' as const, ...(await this.send(legacyTarget, { text: part })) });
      return { receipts };
    }

    const receipts = [];
    for (const content of operation.contents) {
      if (content.type === 'text') {
        for (const part of splitMessagingText(content.text, WEIXIN_TEXT_LIMIT)) {
          const receipt = await this.send(legacyTarget, { text: part, reply_to_id: operation.reply_to_id });
          receipts.push({ type: 'text' as const, ...receipt });
        }
        continue;
      }
      const receipt = await this.sendMedia(legacyTarget, {
        type: content.type,
        data: Buffer.from(content.data),
        name: content.name,
        mimeType: content.mime_type,
      }, content.caption);
      receipts.push({ type: content.type, ...receipt });
    }
    return { receipts };
  }

  async send(target: MessagingTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    if (!target.context_token) {
      throw new MessagingDeliveryError('CONVERSATION_CONTEXT_EXPIRED', 'The contact context has expired. Wait for the contact to send another message.', false);
    }
    const client = this.client();
    await client.sendText({
      toUserId: target.conversation_id,
      contextToken: target.context_token,
      text: message.text,
    });
    return { delivered_at: new Date().toISOString() };
  }

  async setTyping(target: MessagingTarget, status: 1 | 2) {
    if (!target.context_token) throw new MessagingDeliveryError('CONVERSATION_CONTEXT_EXPIRED', 'The contact context has expired. Wait for the contact to send another message.', false);
    const client = this.client();
    try {
      await this.sendTyping(client, target, status);
    } catch (error) {
      this.typingTickets.delete(target.conversation_id);
      if (error instanceof WeixinApiError && error.retryable) throw error;
      await this.sendTyping(client, target, status);
    }
  }

  async sendMedia(target: MessagingTarget, media: WeixinOutboundMedia, caption?: string, runId?: string) {
    if (!target.context_token) throw new MessagingDeliveryError('CONVERSATION_CONTEXT_EXPIRED', 'The contact context has expired. Wait for the contact to send another message.', false);
    const client = this.client();
    const uploaded = await uploadWeixinMedia({
      client,
      toUserId: target.conversation_id,
      media,
    });
    if (caption?.trim()) {
      await client.sendItems({
        toUserId: target.conversation_id,
        contextToken: target.context_token,
        runId,
        items: [{ type: 1, text_item: { text: caption.trim() } }],
      });
    }
    await client.sendItems({
      toUserId: target.conversation_id,
      contextToken: target.context_token,
      runId,
      items: [uploaded.item],
    });
    return { delivered_at: new Date().toISOString() };
  }

  private async poll(context: AdapterContext, signal: AbortSignal) {
    let cursor = context.state.get<string>('weixin.cursor') || '';
    let retryDelay = 1_000;
    const client = this.client();
    while (!signal.aborted) {
      try {
        const response = await client.getUpdates(cursor, signal, WEIXIN_LONG_POLL_TIMEOUT_MS + 5_000);
        if (signal.aborted) break;
        if (response.errcode === -14) {
          this.setStatus(context, {
            state: 'reauth_required',
            changed_at: new Date().toISOString(),
            error: { code: 'WEIXIN_REAUTH_REQUIRED', message: 'WeChat authorization has expired. Reauthorize to reconnect.' },
          });
          return;
        }
        if (response.ret && response.ret !== 0) {
          throw new WeixinApiError('WEIXIN_REMOTE_ERROR', response.errmsg || 'WeChat polling failed', true);
        }
        for (const message of response.msgs || []) {
          const event = toMessagingInboundEvent({
            accountId: this.config.accountId,
            botUserId: this.config.botUserId,
            message,
          });
           if (event) {
             if (event.context_token) context.state.set(`weixin.context:${event.conversation.id}`, event.context_token);
             const { context_token: _contextToken, ...message } = await this.resolveInboundImages(event);
             await context.emit({ type: 'message', message });
           }
        }
        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf !== cursor) {
           context.state.set('weixin.cursor', response.get_updates_buf);
          cursor = response.get_updates_buf;
        }
        retryDelay = 1_000;
        if (this.status.state !== 'connected') {
          this.setStatus(context, { state: 'connected', changed_at: new Date().toISOString() });
        }
      } catch (error) {
        if (signal.aborted) break;
        const apiError = error instanceof WeixinApiError ? error : new WeixinApiError('WEIXIN_UNKNOWN_ERROR', 'WeChat connection failed', true);
        if (!apiError.retryable) {
          this.setStatus(context, {
            state: 'error',
            changed_at: new Date().toISOString(),
            error: { code: apiError.code, message: apiError.message },
          });
          return;
        }
        this.setStatus(context, {
          state: 'reconnecting',
          changed_at: new Date().toISOString(),
          error: { code: apiError.code, message: apiError.message },
        });
        await wait(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    }
  }

  private client() {
    return this.config.client || new WeixinApiClient({ token: this.config.token, baseUrl: this.config.baseUrl });
  }

  private async getTypingTicket(client: WeixinApiClient, target: MessagingTarget) {
    const cached = this.typingTickets.get(target.conversation_id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const config = await client.getConfig({
      userId: target.conversation_id,
      contextToken: target.context_token,
    });
    const ticket = config.typing_ticket?.trim();
    if (!ticket) throw new WeixinApiError('WEIXIN_TYPING_UNAVAILABLE', 'WeChat did not return a typing-status credential', false);
    this.typingTickets.set(target.conversation_id, { value: ticket, expiresAt: Date.now() + 12 * 60 * 60_000 });
    return ticket;
  }

  private async sendTyping(client: WeixinApiClient, target: MessagingTarget, status: 1 | 2) {
    const ticket = await this.getTypingTicket(client, target);
    await client.sendTypingWithTicket({
      userId: target.conversation_id,
      typingTicket: ticket,
      status,
    });
  }

  private async resolveInboundImages(event: Awaited<ReturnType<typeof toMessagingInboundEvent>>) {
    if (!event) throw new Error('Weixin inbound event is missing');
    const segments = await Promise.all(event.message.segments.map(async (segment) => {
      if (segment.type !== 'image' || segment.data) return segment;
      try {
        const data = await downloadWeixinImage({
          downloadUrl: segment.download_url,
          encryptedQueryParam: segment.encrypted_query_param,
          aesKey: segment.aes_key,
          aeskey: segment.aeskey,
        });
        return { ...segment, data: new Uint8Array(data) };
      } catch (error) {
        console.warn(`[messaging] WeChat image download failed message=${event.message.id}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }));
    return { ...event, message: { ...event.message, segments: segments.filter((segment): segment is NonNullable<typeof segment> => segment !== null) } };
  }

  private setStatus(context: AdapterContext, status: AdapterStatus) {
    this.status = status;
    void context.updateStatus(status);
  }
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delay);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
