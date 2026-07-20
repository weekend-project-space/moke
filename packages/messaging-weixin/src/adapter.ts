import type {
  AdapterContext,
  AdapterStatus,
  DeliveryReceipt,
  MessagingAdapter,
  MessagingTarget,
  OutboundMessage,
} from '@moke/messaging-core';
import { WEIXIN_LONG_POLL_TIMEOUT_MS } from './constants.js';
import { WeixinApiClient, WeixinApiError } from './api-client.js';
import { uploadWeixinMedia, type WeixinOutboundMedia } from './outbound-media.js';
import { toMessagingInboundEvent } from './message-converter.js';
import { weixinCapabilities } from './constants.js';

export type WeixinAdapterConfig = {
  accountId: string;
  botUserId?: string;
  token: string;
  baseUrl?: string;
  loadCursor(): Promise<string>;
  saveCursor(cursor: string): Promise<void>;
  client?: WeixinApiClient;
};

export class WeixinAdapter implements MessagingAdapter {
  readonly platform = 'weixin' as const;
  readonly capabilities = weixinCapabilities;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private status: AdapterStatus = { state: 'stopped', changed_at: new Date().toISOString() };
  private readonly typingTickets = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly config: WeixinAdapterConfig) {}

  async start(context: AdapterContext) {
    if (this.loop) return;
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
    void reason;
  }

  getStatus() {
    return this.status;
  }

  async send(target: MessagingTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    if (!target.context_token) {
      throw new WeixinApiError('WEIXIN_CONTEXT_UNAVAILABLE', '联系人上下文已失效，请等待对方再次发送消息', false);
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
    if (!target.context_token) throw new WeixinApiError('WEIXIN_CONTEXT_UNAVAILABLE', '联系人上下文已失效，请等待对方再次发送消息', false);
    const client = this.client();
    try {
      await this.sendTyping(client, target, status);
    } catch (error) {
      this.typingTickets.delete(target.conversation_id);
      if (error instanceof WeixinApiError && error.retryable) throw error;
      await this.sendTyping(client, target, status);
    }
  }

  async sendMedia(target: MessagingTarget, media: WeixinOutboundMedia, caption?: string) {
    if (!target.context_token) throw new WeixinApiError('WEIXIN_CONTEXT_UNAVAILABLE', '联系人上下文已失效，请等待对方再次发送消息', false);
    const client = this.client();
    const uploaded = await uploadWeixinMedia({
      client,
      toUserId: target.conversation_id,
      media,
    });
    await client.sendItems({
      toUserId: target.conversation_id,
      contextToken: target.context_token,
      items: [
        ...(caption?.trim() ? [{ type: 1, text_item: { text: caption.trim() } }] : []),
        uploaded.item,
      ],
    });
    return { delivered_at: new Date().toISOString() };
  }

  private async poll(context: AdapterContext, signal: AbortSignal) {
    let cursor = await this.config.loadCursor();
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
            error: { code: 'WEIXIN_REAUTH_REQUIRED', message: '微信授权已失效，请重新授权' },
          });
          return;
        }
        if (response.ret && response.ret !== 0) {
          throw new WeixinApiError('WEIXIN_REMOTE_ERROR', response.errmsg || '微信长轮询失败', true);
        }
        for (const message of response.msgs || []) {
          const event = toMessagingInboundEvent({
            accountId: this.config.accountId,
            botUserId: this.config.botUserId,
            message,
          });
          if (event) await context.emit(event);
        }
        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf !== cursor) {
          await this.config.saveCursor(response.get_updates_buf);
          cursor = response.get_updates_buf;
        }
        retryDelay = 1_000;
        if (this.status.state !== 'connected') {
          this.setStatus(context, { state: 'connected', changed_at: new Date().toISOString() });
        }
      } catch (error) {
        if (signal.aborted) break;
        const apiError = error instanceof WeixinApiError ? error : new WeixinApiError('WEIXIN_UNKNOWN_ERROR', '微信连接失败', true);
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
    if (!ticket) throw new WeixinApiError('WEIXIN_TYPING_UNAVAILABLE', '微信未返回输入状态凭据', false);
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
