import { DWClient, EventAck, TOPIC_CARD, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';

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
import { DINGTALK_TEXT_LIMIT, dingtalkCapabilities } from './constants.js';
import { extractDingTalkMedia, toDingTalkInboundMessage, type DingTalkRobotMessage } from './message-converter.js';
import { DingTalkAccessTokenProvider } from './access-token.js';
import { DingTalkAiCardService, type DingTalkCardInstance, type DingTalkCardTarget } from './ai-card.js';
import { downloadDingTalkImage } from './media.js';

export type DingTalkAdapterConfig = {
  accountId: string;
  clientId: string;
  clientSecret: string;
  allowedUserIds?: string[];
  cardTemplateId?: string;
  fetcher?: typeof fetch;
};

export type DingTalkCardAction = { openId?: string; conversationId?: string; value: Record<string, unknown> };

export class DingTalkAdapter implements MessagingAdapter {
  readonly platform = 'dingtalk' as const;
  readonly capabilities: ReadonlySet<import('@moke/messaging-core').MessagingCapability>;
  private client: DWClient | undefined;
  private readonly tokens: DingTalkAccessTokenProvider;
  private readonly cards: DingTalkAiCardService;
  private context: AdapterContext | undefined;
  private status: AdapterStatus = { state: 'stopped', changed_at: new Date().toISOString() };

  constructor(private readonly config: DingTalkAdapterConfig) {
    this.tokens = new DingTalkAccessTokenProvider(config.clientId, config.clientSecret, config.fetcher);
    this.cards = new DingTalkAiCardService(config.clientId, () => this.tokens.get(), config.fetcher);
    this.capabilities = new Set(dingtalkCapabilities);
    if (config.cardTemplateId) (this.capabilities as Set<string>).add('interaction');
  }

  async start(context: AdapterContext) {
    if (this.client) return;
    this.context = context;
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
      if (action) void this.emitCardAction(context, action).catch((error) => {
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
    this.context = undefined;
    this.status = { state: 'stopped', changed_at: new Date().toISOString() };
  }

  getStatus() { return this.status; }

  async deliver(
    target: MessagingDeliveryTarget,
    operation: MessagingOutboundOperation,
    previousReference?: Record<string, string>,
  ): Promise<MessagingDeliveryResult> {
    if (operation.kind === 'activity') return { receipts: [], ...(previousReference ? { reference: previousReference } : {}) };
    if (operation.kind === 'message') {
      const receipts = [];
      for (const content of operation.contents) {
        if (content.type !== 'text') throw new MessagingDeliveryError('UNSUPPORTED_CAPABILITY', 'DingTalk outbound media is not supported', false);
        for (const text of splitMessagingText(content.text, DINGTALK_TEXT_LIMIT)) {
          const receipt = await this.send({ account_id: target.account_id, conversation_id: target.conversation.id }, { text, reply_to_id: operation.reply_to_id });
          receipts.push({ type: 'text' as const, ...receipt });
        }
      }
      return { receipts };
    }
    if (operation.kind === 'interaction') {
      if (!this.config.cardTemplateId) {
        const text = operation.resolved
          ? `${operation.title}\n\n${operation.detail}\n\n${operation.resolved.label}`
          : `${operation.title}\n\n${operation.detail}\n\n${operation.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}\n\nOpen Moke to respond.`;
        const receipts = [];
        for (const part of splitMessagingText(text, DINGTALK_TEXT_LIMIT)) receipts.push({ type: 'text' as const, ...(await this.send({ account_id: target.account_id, conversation_id: target.conversation.id }, { text: part })) });
        return { receipts };
      }
      if (previousReference?.kind === 'dingtalk-interaction') {
        if (operation.resolved) {
          await this.updateInteractionCard(referenceToCard(previousReference), {
            title: operation.title,
            content: `${operation.detail}\n\n${operation.resolved.label}`,
          });
        }
        return { receipts: [], reference: previousReference };
      }
      const card = await this.createInteractionCard(cardTarget(target), {
        title: operation.title,
        content: operation.detail,
        actions: operation.options.map((option) => ({
          text: option.label,
          value: { interactionId: operation.interaction_id, optionId: option.id },
        })),
      });
      return { receipts: [], reference: cardToReference('dingtalk-interaction', card) };
    }
    if (operation.kind === 'status') {
      if (previousReference?.kind === 'dingtalk-status') {
        const card = referenceToCard(previousReference);
        await this.updateCard(card, dingtalkStatusText(operation));
        return { receipts: [], reference: cardToReference('dingtalk-status', card) };
      }
      const card = await this.createCard(cardTarget(target), dingtalkStatusText(operation));
      return { receipts: [], reference: cardToReference('dingtalk-status', card) };
    }

    if (previousReference?.kind === 'dingtalk-status') {
      const card = referenceToCard(previousReference);
      await this.updateCard(card, operation.text, true);
      return { receipts: [], reference: cardToReference('dingtalk-status', card) };
    }
    if (operation.message_already_delivered || !operation.text.trim()) return { receipts: [] };
    const receipts = [];
    for (const part of splitMessagingText(operation.text, DINGTALK_TEXT_LIMIT)) receipts.push({ type: 'text' as const, ...(await this.send({ account_id: target.account_id, conversation_id: target.conversation.id }, { text: part })) });
    return { receipts };
  }

  async send(target: MessagingTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    await this.sendText(target.conversation_id, message.text);
    return { delivered_at: new Date().toISOString() };
  }

  async sendText(conversationId: string, text: string) {
    const context = this.context?.state.get<{ sessionWebhook?: string; expiresAt?: string }>(`dingtalk.reply:${conversationId}`);
    if (!context?.sessionWebhook || (context.expiresAt && Date.parse(context.expiresAt) <= Date.now())) throw new MessagingDeliveryError('CONVERSATION_CONTEXT_EXPIRED', 'Send another message in DingTalk to refresh the conversation context', false);
    const token = await this.tokens.get();
    const response = await (this.config.fetcher || fetch)(context.sessionWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'Moke', text } }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const retryable = response.status === 429 || response.status >= 500;
      throw new MessagingDeliveryError(retryable ? 'DINGTALK_SEND_FAILED' : 'DINGTALK_AUTH_FAILED', `HTTP ${response.status} ${detail}`, retryable);
    }
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
    context.state.set('dingtalk.last-stream-event', { topic: event.headers.topic, updatedAt: new Date().toISOString() });
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
    if (inbound.replyContext) context.state.set(`dingtalk.reply:${inbound.replyContext.conversationId}`, {
      sessionWebhook: inbound.replyContext.sessionWebhook,
      sourceMessageId: inbound.replyContext.sourceMessageId,
      ...(inbound.replyContext.expiresAt ? { expiresAt: inbound.replyContext.expiresAt } : {}),
    });
    await context.emit({ type: 'message', message: inbound.event });
  }

  private async emitCardAction(context: AdapterContext, action: DingTalkCardAction) {
    const interactionId = typeof action.value.interactionId === 'string' ? action.value.interactionId : '';
    const optionId = typeof action.value.optionId === 'string' ? action.value.optionId : '';
    if (!interactionId || !optionId) return;
    await context.emit({
      type: 'interaction',
      action: {
        account_id: this.config.accountId,
        ...(action.conversationId ? { conversation_id: action.conversationId } : {}),
        ...(action.openId ? { sender_id: action.openId } : {}),
        interaction_id: interactionId,
        option_id: optionId,
      },
    });
  }

  private setStatus(context: AdapterContext, status: AdapterStatus) { this.status = status; void context.updateStatus(status); }
}

function normalizeCardAction(raw: unknown): DingTalkCardAction | null {
  const root = parseJson(raw);
  const values = collect(root);
  const value = values.find((item) => item && typeof item === 'object'
    && (typeof (item as Record<string, unknown>).runId === 'string' || typeof (item as Record<string, unknown>).interactionId === 'string')) as Record<string, unknown> | undefined;
  if (!value) return null;
  const actor = values.find((item) => item && typeof item === 'object' && ['userId', 'staffId', 'operatorId'].some((key) => typeof (item as Record<string, unknown>)[key] === 'string')) as Record<string, unknown> | undefined;
  const openId = actor && ['userId', 'staffId', 'operatorId'].map((key) => actor[key]).find((item): item is string => typeof item === 'string');
  const conversationId = values
    .map((item) => item && typeof item === 'object' ? (item as Record<string, unknown>).conversationId || (item as Record<string, unknown>).openConversationId : undefined)
    .find((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return { value, ...(openId ? { openId } : {}), ...(conversationId ? { conversationId } : {}) };
}

function cardTarget(target: MessagingDeliveryTarget): DingTalkCardTarget {
  if (target.conversation.type === 'group') return { type: 'group', conversationId: target.conversation.id };
  const userId = target.sender_id || target.conversation.id;
  return { type: 'user', userId };
}

function cardToReference(kind: 'dingtalk-status' | 'dingtalk-interaction', card: DingTalkCardInstance) {
  return { kind, card_id: card.id, started: card.started ? '1' : '0' };
}

function referenceToCard(reference: Record<string, string>): DingTalkCardInstance {
  const id = reference.card_id;
  if (!id) throw new Error('DingTalk card reference is invalid');
  return { id, started: reference.started === '1' };
}

function dingtalkStatusText(operation: Extract<MessagingOutboundOperation, { kind: 'status' }>) {
  return operation.detail?.trim() || operation.title;
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
