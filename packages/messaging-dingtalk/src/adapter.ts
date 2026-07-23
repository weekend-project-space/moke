import { DWClient, EventAck, TOPIC_CARD, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';

import type { AdapterContext, AdapterStatus, DeliveryReceipt, MessagingAdapter, MessagingTarget, OutboundMessage } from '@moke/messaging-core';
import { dingtalkCapabilities } from './constants.js';
import { extractDingTalkMedia, toDingTalkInboundMessage, type DingTalkRobotMessage } from './message-converter.js';
import { DingTalkAccessTokenProvider } from './access-token.js';
import { DingTalkAiCardService, type DingTalkCardInstance, type DingTalkCardTarget } from './ai-card.js';
import { downloadDingTalkImage } from './media.js';

export type DingTalkAdapterConfig = {
  accountId: string;
  clientId: string;
  clientSecret: string;
  saveReplyContext(input: { conversationId: string; sessionWebhook: string; sourceMessageId: string; expiresAt?: string }): Promise<void>;
  loadReplyContext(conversationId: string): { sessionWebhook?: string; expiresAt?: string } | null;
  recordStreamEvent?(topic: string): void | Promise<void>;
  allowedUserIds?: string[];
  cardTemplateId?: string;
  onCardAction?(action: DingTalkCardAction): Promise<unknown> | unknown;
  fetcher?: typeof fetch;
};

export type DingTalkCardAction = { openId?: string; value: Record<string, unknown> };

export class DingTalkAdapter implements MessagingAdapter {
  readonly platform = 'dingtalk' as const;
  readonly capabilities = dingtalkCapabilities;
  private client: DWClient | undefined;
  private readonly tokens: DingTalkAccessTokenProvider;
  private readonly cards: DingTalkAiCardService;
  private status: AdapterStatus = { state: 'stopped', changed_at: new Date().toISOString() };

  constructor(private readonly config: DingTalkAdapterConfig) {
    this.tokens = new DingTalkAccessTokenProvider(config.clientId, config.clientSecret, config.fetcher);
    this.cards = new DingTalkAiCardService(config.clientId, () => this.tokens.get(), config.fetcher);
  }

  async start(context: AdapterContext) {
    if (this.client) return;
    this.setStatus(context, { state: 'starting', changed_at: new Date().toISOString() });
    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      autoReconnect: true,
      keepAlive: true,
    } as ConstructorParameters<typeof DWClient>[0]);
    client.registerCallbackListener(TOPIC_ROBOT, (event) => {
      void this.handleBotMessage(context, event).catch((error) => {
        console.warn(`[messaging] DingTalk message failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { status: EventAck.SUCCESS, message: 'OK' };
    });
    client.registerCallbackListener(TOPIC_CARD, (event) => {
      const action = normalizeCardAction(event.data);
      if (action) void Promise.resolve(this.config.onCardAction?.(action)).catch((error) => {
        console.warn(`[messaging] DingTalk card action failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { status: EventAck.SUCCESS, message: 'OK' };
    });
    await client.connect();
    if (!client.connected) throw new Error('DingTalk Stream did not connect');
    this.client = client;
    this.setStatus(context, { state: 'connected', changed_at: new Date().toISOString() });
  }

  async stop(_reason: 'user' | 'shutdown' | 'reauth' | 'error') {
    this.client?.disconnect();
    this.client = undefined;
    this.status = { state: 'stopped', changed_at: new Date().toISOString() };
  }

  getStatus() { return this.status; }

  async send(target: MessagingTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    await this.sendText(target.conversation_id, message.text);
    return { delivered_at: new Date().toISOString() };
  }

  async sendText(conversationId: string, text: string) {
    const context = this.config.loadReplyContext(conversationId);
    if (!context?.sessionWebhook || (context.expiresAt && Date.parse(context.expiresAt) <= Date.now())) throw new Error('CONVERSATION_CONTEXT_EXPIRED: Send another message in DingTalk to refresh the conversation context');
    const token = await this.tokens.get();
    const response = await (this.config.fetcher || fetch)(context.sessionWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'Moke', text } }),
    });
    if (!response.ok) throw new Error(`DINGTALK_SEND_FAILED: HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }

  createCard(target: DingTalkCardTarget, content: string) { return this.cards.create(target, content); }

  createInteractionCard(target: DingTalkCardTarget, input: { title: string; content: string; actions: Array<{ text: string; value: Record<string, unknown> }> }) {
    if (!this.config.cardTemplateId) throw new Error('DingTalk interactive card template is not configured');
    const params: Record<string, unknown> = {
      title: input.title,
      msgContent: input.content,
      actions: JSON.stringify(input.actions),
      permissionActions: JSON.stringify(input.actions),
    };
    input.actions.slice(0, 3).forEach((action, index) => {
      params[`action${index + 1}Text`] = action.text;
      params[`action${index + 1}Value`] = JSON.stringify(action.value);
    });
    return this.cards.create(target, input.content, { templateId: this.config.cardTemplateId, params, callbackRouteKey: 'moke_interaction' });
  }

  updateInteractionCard(card: DingTalkCardInstance, input: { title: string; content: string }) {
    return this.cards.updateData(card, {
      title: input.title,
      msgContent: input.content,
      actions: '[]',
      permissionActions: '[]',
      action1Text: '',
      action1Value: '',
      action2Text: '',
      action2Value: '',
      action3Text: '',
      action3Value: '',
    });
  }

  updateCard(card: DingTalkCardInstance, content: string, finished = false) { return this.cards.update(card, content, finished); }

  private async handleBotMessage(context: AdapterContext, event: DWClientDownStream) {
    await this.config.recordStreamEvent?.(event.headers.topic);
    const message = JSON.parse(event.data) as DingTalkRobotMessage;
    const senderId = message.senderStaffId?.trim() || message.senderId?.trim() || '';
    if (this.config.allowedUserIds?.length && !this.config.allowedUserIds.includes(senderId)) return;
    const media = extractDingTalkMedia(message);
    const image = media.find((item) => item.kind === 'image');
    const file = media.find((item) => item.kind === 'file');
    const imageData = image ? await downloadDingTalkImage({
      candidate: image,
      robotCode: this.config.clientId,
      accessToken: await this.tokens.get(),
      fetcher: this.config.fetcher,
    }) : undefined;
    const inbound = toDingTalkInboundMessage({
      accountId: this.config.accountId,
      eventId: event.headers.eventId || event.headers.messageId,
      message: { ...message, imageData, ...(file?.fileName ? { fileName: file.fileName } : {}) },
    });
    if (!inbound) return;
    if (inbound.replyContext) await this.config.saveReplyContext(inbound.replyContext);
    await context.emit(inbound.event);
  }

  private setStatus(context: AdapterContext, status: AdapterStatus) { this.status = status; void context.updateStatus(status); }
}

function normalizeCardAction(raw: unknown): DingTalkCardAction | null {
  const root = parseJson(raw);
  const values = collect(root);
  const value = values.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).runId === 'string') as Record<string, unknown> | undefined;
  if (!value) return null;
  const actor = values.find((item) => item && typeof item === 'object' && ['userId', 'staffId', 'operatorId'].some((key) => typeof (item as Record<string, unknown>)[key] === 'string')) as Record<string, unknown> | undefined;
  const openId = actor && ['userId', 'staffId', 'operatorId'].map((key) => actor[key]).find((item): item is string => typeof item === 'string');
  return { value, ...(openId ? { openId } : {}) };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function collect(value: unknown, seen = new Set<unknown>()): unknown[] {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object') return parsed === value ? [parsed] : [parsed, ...collect(parsed, seen)];
  if (seen.has(parsed)) return [];
  seen.add(parsed);
  return [parsed, ...Object.values(parsed).flatMap((item) => collect(item, seen))];
}
