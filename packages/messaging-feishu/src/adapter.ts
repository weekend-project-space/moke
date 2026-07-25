import * as Lark from '@larksuiteoapi/node-sdk';

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
import { FEISHU_TEXT_LIMIT, feishuCapabilities } from './constants.js';
import { toFeishuInboundEvent } from './message-converter.js';

const HANDSHAKE_TIMEOUT_MS = 15_000;

export type FeishuDomain = 'feishu' | 'lark';

export type FeishuIdentity = {
  openId: string;
  name: string;
  avatarUrl?: string;
};

export type FeishuCardAction = {
  openId?: string;
  chatId?: string;
  value: Record<string, unknown>;
};

export type FeishuOutboundMedia = {
  type: 'image' | 'file';
  data: Buffer;
  name: string;
  mimeType: string;
};

export type FeishuAdapterConfig = {
  accountId: string;
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
};

export class FeishuAdapter implements MessagingAdapter {
  readonly platform = 'feishu' as const;
  readonly capabilities = feishuCapabilities;
  private readonly client: Lark.Client;
  private wsClient: Lark.WSClient | undefined;
  private identity: FeishuIdentity | undefined;
  private status: AdapterStatus = { state: 'stopped', changed_at: new Date().toISOString() };

  constructor(private readonly config: FeishuAdapterConfig) {
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: domainFor(config.domain),
    });
  }

  async start(context: AdapterContext) {
    if (this.wsClient) return;
    this.setStatus(context, { state: 'starting', changed_at: new Date().toISOString() });
    this.identity = await resolveFeishuIdentity(this.client);

    const dispatcher = new Lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        const event = toFeishuInboundEvent({ accountId: this.config.accountId, message: await normalizeMessageEvent(this.client, data) });
        if (event) await context.emit({ type: 'message', message: event });
      },
      'card.action.trigger': async (data: unknown) => {
        const action = normalizeCardAction(data);
        const ack = await context.emit({
          type: 'interaction',
          action: {
            account_id: this.config.accountId,
            ...(action.chatId ? { conversation_id: action.chatId } : {}),
            ...(action.openId ? { sender_id: action.openId } : {}),
            interaction_id: typeof action.value.interactionId === 'string' ? action.value.interactionId : '',
            option_id: typeof action.value.optionId === 'string' ? action.value.optionId : '',
          },
        });
        return 'message' in ack ? { toast: { type: ack.status === 'accepted' ? 'success' : 'warning', content: ack.message } } : undefined;
      },
    } as never);

    const wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: domainFor(this.config.domain),
      loggerLevel: Lark.LoggerLevel.error,
      source: 'moke',
      autoReconnect: true,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      onReady: () => this.setStatus(context, { state: 'connected', changed_at: new Date().toISOString() }),
      onReconnecting: () => this.setStatus(context, { state: 'reconnecting', changed_at: new Date().toISOString() }),
      onReconnected: () => this.setStatus(context, { state: 'connected', changed_at: new Date().toISOString() }),
      onError: (error) => this.setStatus(context, {
        state: 'error',
        changed_at: new Date().toISOString(),
        error: { code: 'FEISHU_STREAM_ERROR', message: error.message },
      }),
    });
    this.wsClient = wsClient;
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
      if (this.status.state === 'starting') {
        this.setStatus(context, { state: 'connected', changed_at: new Date().toISOString() });
      }
    } catch (error) {
      this.wsClient = undefined;
      wsClient.close({ force: true });
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(context, {
        state: 'error',
        changed_at: new Date().toISOString(),
        error: { code: 'FEISHU_CONNECTION_FAILED', message },
      });
      throw error;
    }
  }

  async stop(_reason: 'user' | 'shutdown' | 'reauth' | 'error') {
    this.wsClient?.close({ force: true });
    this.wsClient = undefined;
    this.status = { state: 'stopped', changed_at: new Date().toISOString() };
  }

  getStatus() { return this.status; }

  getIdentity() { return this.identity; }

  async deliver(
    target: MessagingDeliveryTarget,
    operation: MessagingOutboundOperation,
    previousReference?: Record<string, string>,
  ): Promise<MessagingDeliveryResult> {
    const legacyTarget: MessagingTarget = { account_id: target.account_id, conversation_id: target.conversation.id };
    if (operation.kind === 'activity') return { receipts: [], ...(previousReference ? { reference: previousReference } : {}) };
    if (operation.kind === 'message') {
      const receipts = [];
      for (const content of operation.contents) {
        if (content.type === 'text') {
          for (const text of splitMessagingText(content.text, FEISHU_TEXT_LIMIT)) {
            const receipt = await this.send(legacyTarget, { text, reply_to_id: operation.reply_to_id });
            receipts.push({ type: 'text' as const, ...receipt });
          }
        } else {
          const receipt = await this.sendMedia(legacyTarget, {
            type: content.type,
            data: Buffer.from(content.data),
            name: content.name,
            mimeType: content.mime_type,
          });
          receipts.push({ type: content.type, ...receipt });
          if (content.caption?.trim()) {
            const caption = await this.send(legacyTarget, { text: content.caption.trim() });
            receipts.push({ type: 'text' as const, ...caption });
          }
        }
      }
      return { receipts };
    }

    if (operation.kind === 'status') {
      const card = feishuStatusCard(operation.title, operation.detail || '');
      const reference = await this.upsertCard(target.conversation.id, card, previousReference);
      return { receipts: [], reference };
    }
    if (operation.kind === 'interaction') {
      const card = operation.resolved
        ? feishuResolvedInteractionCard(operation.title, operation.detail, operation.resolved.label)
        : feishuInteractionCard(operation);
      const reference = await this.upsertCard(target.conversation.id, card, previousReference);
      return { receipts: [], reference };
    }

    const reference = previousReference?.message_id
      ? await this.upsertCard(target.conversation.id, feishuStatusCard(
          operation.outcome === 'completed' ? 'Completed' : operation.outcome === 'failed' ? 'Failed' : 'Cancelled',
          operation.outcome === 'completed' ? 'Response sent.' : operation.text,
          true,
        ), previousReference)
      : undefined;
    const receipts = [];
    if (!operation.message_already_delivered && operation.text.trim()) {
      for (const text of splitMessagingText(operation.text, FEISHU_TEXT_LIMIT)) {
        const receipt = await this.send(legacyTarget, { text });
        receipts.push({ type: 'text' as const, ...receipt });
      }
    }
    return { receipts, ...(reference ? { reference } : {}) };
  }

  async send(target: MessagingTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    if (this.status.state !== 'connected') throw new MessagingDeliveryError('CONNECTION_NOT_ACTIVE', 'Feishu connection is not active', true);
    const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: message.text }]] } });
    const response = message.reply_to_id
      ? await this.client.im.message.reply({
          path: { message_id: message.reply_to_id },
          data: { content, msg_type: 'post' },
        })
      : await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: target.conversation_id, msg_type: 'post', content },
        });
    return {
      ...(response.data?.message_id ? { platform_message_id: response.data.message_id } : {}),
      delivered_at: new Date().toISOString(),
    };
  }

  async sendMedia(target: MessagingTarget, media: FeishuOutboundMedia): Promise<DeliveryReceipt> {
    if (this.status.state !== 'connected') throw new MessagingDeliveryError('CONNECTION_NOT_ACTIVE', 'Feishu connection is not active', true);
    const resourceKey = media.type === 'image'
      ? (await this.client.im.image.create({ data: { image_type: 'message', image: media.data } }))?.image_key
      : (await this.client.im.file.create({ data: {
          file_type: detectFeishuFileType(media.name),
          file_name: media.name,
          file: media.data,
        } }))?.file_key;
    if (!resourceKey) throw new MessagingDeliveryError('FEISHU_MEDIA_UPLOAD_FAILED', `Feishu ${media.type} upload returned no resource key`, true);
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: target.conversation_id,
        msg_type: media.type,
        content: JSON.stringify(media.type === 'image' ? { image_key: resourceKey } : { file_key: resourceKey }),
      },
    });
    return {
      ...(response.data?.message_id ? { platform_message_id: response.data.message_id } : {}),
      delivered_at: new Date().toISOString(),
    };
  }

  async createCard(chatId: string, card: Record<string, unknown>) {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    const messageId = response.data?.message_id;
    if (!messageId) throw new MessagingDeliveryError('FEISHU_CARD_CREATE_FAILED', 'Feishu card creation returned no message id', true);
    return messageId;
  }

  async updateCard(messageId: string, card: Record<string, unknown>) {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  private async upsertCard(chatId: string, card: Record<string, unknown>, previousReference?: Record<string, string>) {
    const messageId = previousReference?.message_id;
    if (messageId) {
      await this.updateCard(messageId, card);
      return previousReference;
    }
    return { message_id: await this.createCard(chatId, card) };
  }

  private setStatus(context: AdapterContext, status: AdapterStatus) {
    this.status = status;
    void context.updateStatus(status);
  }
}

export async function resolveFeishuIdentity(client: Pick<Lark.Client, 'request'>): Promise<FeishuIdentity> {
  const response = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }) as {
    bot?: { open_id?: string; app_name?: string; avatar_url?: string };
    data?: { bot?: { open_id?: string; app_name?: string; avatar_url?: string } };
  };
  const bot = response.bot || response.data?.bot;
  const openId = bot?.open_id?.trim();
  if (!openId) throw new Error('Feishu bot is not enabled or bot information is unavailable');
  return {
    openId,
    name: bot?.app_name?.trim() || 'Feishu',
    ...(bot?.avatar_url?.trim() ? { avatarUrl: bot.avatar_url.trim() } : {}),
  };
}

async function normalizeMessageEvent(client: Lark.Client, value: unknown) {
  const event = value as {
    sender?: { sender_id?: { open_id?: string } };
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
    };
  };
  const messageType = event.message?.message_type;
  const content = parseMessageText(event.message?.content, messageType);
  const imageKey = messageType === 'image' ? parseResourceKey(event.message?.content, 'image_key') : undefined;
  const imageData = imageKey && event.message?.message_id
    ? await downloadMessageResource(client, event.message.message_id, imageKey, 'image')
    : undefined;
  return {
    content,
    senderId: event.sender?.sender_id?.open_id,
    chatId: event.message?.chat_id,
    chatType: event.message?.chat_type === 'group' ? 'group' : 'direct',
    messageId: event.message?.message_id,
    imageData,
  };
}

async function downloadMessageResource(client: Lark.Client, messageId: string, fileKey: string, type: string) {
  const resource = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of resource.getReadableStream()) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += data.length;
    if (totalBytes > 5 * 1024 * 1024) throw new Error('Feishu image exceeds the 5 MB input limit');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

function parseResourceKey(content: string | undefined, key: 'image_key' | 'file_key') {
  if (!content) return undefined;
  try {
    const value = (JSON.parse(content) as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCardAction(value: unknown): FeishuCardAction {
  const event = value as {
    operator?: { open_id?: string };
    action?: { value?: Record<string, unknown> };
    context?: { open_chat_id?: string };
  };
  return {
    openId: event.operator?.open_id,
    chatId: event.context?.open_chat_id,
    value: event.action?.value || {},
  };
}

function parseMessageText(content: string | undefined, messageType: string | undefined) {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return messageType === 'text' ? parsed.text || '' : '';
  } catch {
    return '';
  }
}

function domainFor(domain: FeishuDomain | undefined) {
  return domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

function detectFeishuFileType(name: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'opus' || extension === 'mp4' || extension === 'pdf') return extension;
  if (extension === 'doc' || extension === 'docx') return 'doc';
  if (extension === 'xls' || extension === 'xlsx') return 'xls';
  if (extension === 'ppt' || extension === 'pptx') return 'ppt';
  return 'stream';
}

function feishuStatusCard(title: string, content: string, terminal = false) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: terminal ? 'grey' : 'blue' },
    elements: [{ tag: 'markdown', content }],
  };
}

function feishuInteractionCard(operation: Extract<MessagingOutboundOperation, { kind: 'interaction' }>) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: operation.title }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: operation.detail },
      {
        tag: 'action',
        actions: operation.options.map((option) => ({
          tag: 'button', text: { tag: 'plain_text', content: option.label }, type: 'primary',
          value: { interactionId: operation.interaction_id, optionId: option.id },
        })),
      },
    ],
  };
}

function feishuResolvedInteractionCard(title: string, detail: string, result: string) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'grey' },
    elements: [{ tag: 'markdown', content: `${detail}\n\n**${result}**` }],
  };
}
