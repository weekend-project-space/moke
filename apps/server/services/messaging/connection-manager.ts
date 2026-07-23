import type { AdapterStatus, MessagingAdapter, MessagingTarget } from '@moke/messaging-core';
import { WeixinAdapter, splitWeixinText, WEIXIN_TEXT_LIMIT, type WeixinOutboundMedia } from '@moke/messaging-weixin';
import { DingTalkAdapter, type DingTalkCardAction, type DingTalkCardInstance } from '@moke/messaging-dingtalk';
import { FeishuAdapter, type FeishuCardAction, type FeishuOutboundMedia } from '@moke/messaging-feishu';
import { JsonMessagingStore } from '../../storage/messaging-store.js';
import { MessagingGateway } from './messaging-gateway.js';

export class MessagingConnectionManager {
  private readonly adapters = new Map<string, MessagingAdapter>();
  private readonly typingRuns = new Map<string, TypingRun>();
  private cardActionHandler: ((action: FeishuCardAction | DingTalkCardAction) => Promise<unknown> | unknown) | undefined;

  constructor(
    private readonly store: JsonMessagingStore,
    private readonly gateway: MessagingGateway,
  ) {}

  setCardActionHandler(handler: (action: FeishuCardAction | DingTalkCardAction) => Promise<unknown> | unknown) {
    this.cardActionHandler = handler;
  }

  async startAll() {
    for (const connection of this.store.listConnections()) {
      if (connection.enabled) await this.startSafely(connection.id, () => this.start(connection.id));
    }
  }

  async start(connectionId: string) {
    const connection = this.store.getConnection(connectionId);
    if (!connection) return null;
    if (connection.platform === 'dingtalk') return this.startDingTalk(connection.id);
    if (connection.platform === 'feishu') return this.startFeishu(connection.id);
    return this.startWeixin(connection.id);
  }

  private async startWeixin(connectionId: string) {
    if (this.adapters.has(connectionId)) return this.store.getPublicConnection(connectionId);
    const connection = this.store.getWeixinConnection(connectionId);
    if (!connection) throw new Error('Weixin connection not found');
    const token = this.store.getToken(connection);
    if (!token) {
      this.store.updateConnectionState(connectionId, {
        state: 'reauth_required',
        error: { code: 'WEIXIN_AUTH_MISSING', message: 'WeChat authorization is missing. Reauthorize to reconnect.' },
      });
      return this.store.getPublicConnection(connectionId);
    }
    const adapter = new WeixinAdapter({
      accountId: connection.id,
      botUserId: connection.ilink_bot_id,
      token,
      baseUrl: connection.api_base_url,
      loadCursor: async () => this.store.getCursor(connection.id),
      saveCursor: async (cursor) => this.store.saveCursor(connection.id, cursor),
    });
    this.adapters.set(connection.id, adapter);
    try {
      await adapter.start({
        account: { id: connection.id, platform: 'weixin', name: connection.name, enabled: connection.enabled },
        signal: new AbortController().signal,
        emit: (event) => this.gateway.accept(event),
        updateStatus: (status) => this.updateStatus(connection.id, status),
      });
    } catch (error) {
      this.adapters.delete(connection.id);
      throw error;
    }
    return this.store.getPublicConnection(connectionId);
  }

  async stop(connectionId: string, reason: 'user' | 'shutdown' | 'reauth' = 'user') {
    const connection = this.store.getConnection(connectionId);
    if (!connection) return null;
    if (connection.platform === 'dingtalk') return this.stopDingTalk(connection.id, reason);
    if (connection.platform === 'feishu') return this.stopFeishu(connection.id, reason);
    return this.stopWeixin(connection.id, reason);
  }

  private async stopWeixin(connectionId: string, reason: 'user' | 'shutdown' | 'reauth' = 'user') {
    const adapter = this.adapters.get(connectionId);
    if (adapter) {
      await adapter.stop(reason);
      this.adapters.delete(connectionId);
    }
    const record = this.store.getWeixinConnection(connectionId);
    if (record && record.state !== 'reauth_required' && record.state !== 'error') {
      this.store.updateConnectionState(connectionId, { state: 'stopped' });
    }
    return this.store.getPublicConnection(connectionId);
  }

  private async startDingTalk(connectionId: string) {
    if (this.adapters.has(connectionId)) return this.store.getPublicConnection(connectionId);
    const connection = this.store.getDingTalkConnection(connectionId);
    if (!connection) throw new Error('DingTalk connection not found');
    const clientSecret = this.store.getDingTalkClientSecret(connection);
    if (!clientSecret) {
      return this.store.updateConnectionState(connectionId, {
        state: 'reauth_required',
        error: { code: 'DINGTALK_AUTH_MISSING', message: 'DingTalk app credentials are missing. Configure the channel again.' },
      });
    }
    const adapter = new DingTalkAdapter({
      accountId: connection.id,
      clientId: connection.client_id,
      clientSecret,
      saveReplyContext: async (input) => this.store.saveDingTalkReplyContext({ connectionId, ...input }),
      loadReplyContext: (conversationId) => this.store.getDingTalkReplyContext(connectionId, conversationId),
      recordStreamEvent: (topic) => this.store.recordDingTalkStreamEvent(connectionId, topic),
      allowedUserIds: connection.allowed_user_ids,
      cardTemplateId: connection.card_template_id,
      onCardAction: (action) => this.cardActionHandler?.(action),
    });
    this.adapters.set(connectionId, adapter);
    try {
      await adapter.start({
        account: { id: connection.id, platform: 'dingtalk', name: connection.name, enabled: connection.enabled },
        signal: new AbortController().signal,
        emit: (event) => this.gateway.accept(event),
        updateStatus: (status) => { this.updateStatus(connectionId, status); },
      });
    } catch (error) {
      this.adapters.delete(connectionId);
      throw error;
    }
    return this.store.getPublicConnection(connectionId);
  }

  private async stopDingTalk(connectionId: string, reason: 'user' | 'shutdown' | 'reauth' = 'user') {
    const adapter = this.adapters.get(connectionId);
    if (adapter?.platform === 'dingtalk') {
      await adapter.stop(reason);
      this.adapters.delete(connectionId);
    }
    const record = this.store.getDingTalkConnection(connectionId);
    if (record && record.state !== 'reauth_required' && record.state !== 'error') {
      this.store.updateConnectionState(connectionId, { state: 'stopped' });
    }
    return this.store.getPublicConnection(connectionId);
  }

  private async startFeishu(connectionId: string) {
    if (this.adapters.has(connectionId)) return this.store.getPublicConnection(connectionId);
    const connection = this.store.getFeishuConnection(connectionId);
    if (!connection) throw new Error('Feishu connection not found');
    const appSecret = this.store.getFeishuAppSecret(connection);
    if (!appSecret) {
      return this.store.updateConnectionState(connectionId, {
        state: 'reauth_required',
        error: { code: 'FEISHU_AUTH_MISSING', message: 'Feishu app credentials are missing. Configure the channel again.' },
      });
    }
    const adapter = new FeishuAdapter({
      accountId: connection.id,
      appId: connection.app_id,
      appSecret,
      domain: connection.domain,
      onCardAction: (action) => this.cardActionHandler?.(action),
    });
    this.adapters.set(connection.id, adapter);
    try {
      await adapter.start({
        account: { id: connection.id, platform: 'feishu', name: connection.name, enabled: connection.enabled },
        signal: new AbortController().signal,
        emit: (event) => this.gateway.accept(event),
        updateStatus: (status) => { this.updateStatus(connection.id, status); },
      });
      const identity = adapter.getIdentity();
      if (identity) this.store.updateFeishuIdentity(connectionId, identity);
    } catch (error) {
      this.adapters.delete(connection.id);
      throw error;
    }
    return this.store.getPublicConnection(connectionId);
  }

  private async stopFeishu(connectionId: string, reason: 'user' | 'shutdown' | 'reauth' = 'user') {
    const adapter = this.adapters.get(connectionId);
    if (adapter?.platform === 'feishu') {
      await adapter.stop(reason);
      this.adapters.delete(connectionId);
    }
    const record = this.store.getFeishuConnection(connectionId);
    if (record && record.state !== 'reauth_required' && record.state !== 'error') {
      this.store.updateConnectionState(connectionId, { state: 'stopped' });
    }
    return this.store.getPublicConnection(connectionId);
  }

  async remove(connectionId: string) {
    try {
      await this.stop(connectionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[messaging] connection stop failed during removal id=${connectionId}: ${message}`);
    } finally {
      this.adapters.delete(connectionId);
      this.store.deleteConnection(connectionId);
    }
  }

  async sendText(connectionId: string, conversationId: string, text: string) {
    const adapter = this.adapters.get(connectionId);
    if (!adapter) throw new Error('微信连接未启动');
    const contextToken = this.store.getContextToken(connectionId, conversationId);
    const target: MessagingTarget = {
      account_id: connectionId,
      conversation_id: conversationId,
      ...(contextToken ? { context_token: contextToken } : {}),
    };
    for (const part of splitWeixinText(text, WEIXIN_TEXT_LIMIT)) {
      await adapter.send(target, { text: part });
    }
    this.store.recordOutbound(connectionId);
  }

  async sendTextForBinding(connectionId: string, bindingId: string, text: string) {
    const binding = this.store.getBinding(bindingId);
    if (!binding || binding.account_id !== connectionId) throw new Error('消息会话绑定不存在');
    const adapter = this.adapters.get(connectionId);
    if (!adapter || adapter.platform !== binding.platform) {
      throw new Error(`${binding.platform} connection is not active`);
    }
    const limit = adapter.capabilities.max_text_length;
    const parts = binding.platform === 'weixin' ? splitWeixinText(text, limit) : splitText(text, limit);
    for (const textPart of parts) {
      await adapter.send({ account_id: connectionId, conversation_id: binding.conversation_id }, { text: textPart });
    }
    this.store.recordOutbound(connectionId, binding.platform);
  }

  async sendMediaForBinding(connectionId: string, bindingId: string, media: WeixinOutboundMedia | FeishuOutboundMedia, caption?: string, runId?: string) {
    const binding = this.store.getBinding(bindingId);
    if (!binding || binding.account_id !== connectionId) throw new Error('Messaging binding is not available');
    const adapter = this.adapters.get(connectionId);
    if (!adapter || adapter.platform !== binding.platform) throw new Error(`${binding.platform} connection is not active`);
    if (adapter instanceof FeishuAdapter) {
      await adapter.sendMedia({ account_id: connectionId, conversation_id: binding.conversation_id }, media);
      if (caption?.trim()) await adapter.send({ account_id: connectionId, conversation_id: binding.conversation_id }, { text: caption.trim() });
      this.store.recordOutbound(connectionId, 'feishu');
      return;
    }
    if (!(adapter instanceof WeixinAdapter)) throw new Error('This channel does not support media delivery');
    const contextToken = this.store.getContextToken(connectionId, binding.conversation_id);
    await adapter.sendMedia({
      account_id: connectionId,
      conversation_id: binding.conversation_id,
      ...(contextToken ? { context_token: contextToken } : {}),
    }, media, caption, runId);
    this.store.recordOutbound(connectionId);
  }

  getBindingPlatform(bindingId: string) {
    return this.store.getBinding(bindingId)?.platform;
  }

  getBindingSender(bindingId: string) {
    return this.store.getBinding(bindingId)?.last_sender_id;
  }

  async createRunCardForBinding(connectionId: string, bindingId: string, presentation: RunPresentation): Promise<RunCardHandle> {
    const binding = this.store.getBinding(bindingId);
    const adapter = this.adapters.get(connectionId);
    if (!binding || binding.account_id !== connectionId || !adapter || adapter.platform !== binding.platform) {
      throw new Error('Messaging connection is not active');
    }
    if (adapter instanceof FeishuAdapter) {
      const messageId = await adapter.createCard(binding.conversation_id, feishuStatusCard(presentation));
      this.store.recordOutbound(connectionId, 'feishu');
      return { platform: 'feishu', messageId };
    }
    if (adapter instanceof DingTalkAdapter) {
      const userId = binding.last_sender_id;
      if (!userId) throw new Error('DingTalk card recipient is unavailable');
      const card = await adapter.createCard({ type: 'user', userId }, dingtalkStatusText(presentation));
      this.store.recordOutbound(connectionId, 'dingtalk');
      return { platform: 'dingtalk', card };
    }
    throw new Error('This channel does not support run cards');
  }

  async updateRunCard(connectionId: string, handle: RunCardHandle, presentation: RunPresentation) {
    const adapter = this.adapters.get(connectionId);
    if (handle.platform === 'feishu' && adapter instanceof FeishuAdapter) {
      await adapter.updateCard(handle.messageId, feishuStatusCard(presentation));
      return;
    }
    if (handle.platform === 'dingtalk' && adapter instanceof DingTalkAdapter) {
      await adapter.updateCard(handle.card, dingtalkStatusText(presentation), presentation.terminal);
      return;
    }
    throw new Error('Messaging run card connection is not active');
  }

  async createInteractionCardForBinding(connectionId: string, bindingId: string, input: InteractionPresentation): Promise<InteractionCardHandle> {
    const binding = this.store.getBinding(bindingId);
    const adapter = this.adapters.get(connectionId);
    if (!binding || binding.account_id !== connectionId || !adapter || adapter.platform !== binding.platform) {
      throw new Error('Messaging interaction connection is not active');
    }
    if (adapter instanceof FeishuAdapter) {
      const messageId = await adapter.createCard(binding.conversation_id, feishuInteractionCard(input));
      this.store.recordOutbound(connectionId, 'feishu');
      return { platform: 'feishu', messageId };
    }
    if (adapter instanceof DingTalkAdapter) {
      const userId = binding.last_sender_id;
      if (!userId) throw new Error('DingTalk interaction recipient is unavailable');
      const card = await adapter.createInteractionCard({ type: 'user', userId }, input);
      this.store.recordOutbound(connectionId, 'dingtalk');
      return { platform: 'dingtalk', card };
    }
    throw new Error('This channel does not support interaction cards');
  }

  async updateInteractionCard(connectionId: string, handle: InteractionCardHandle, input: ResolvedInteractionPresentation) {
    const adapter = this.adapters.get(connectionId);
    if (handle.platform === 'feishu' && adapter instanceof FeishuAdapter) {
      await adapter.updateCard(handle.messageId, feishuResolvedInteractionCard(input));
      return;
    }
    if (handle.platform === 'dingtalk' && adapter instanceof DingTalkAdapter) {
      await adapter.updateInteractionCard(handle.card, input);
      return;
    }
    throw new Error('Messaging interaction card connection is not active');
  }

  startTypingForBinding(connectionId: string, bindingId: string, runId: string) {
    if (this.typingRuns.has(runId)) return;
    const binding = this.store.getBinding(bindingId);
    const adapter = this.adapters.get(connectionId);
    if (!binding || binding.account_id !== connectionId || !(adapter instanceof WeixinAdapter)) return;
    const contextToken = this.store.getContextToken(connectionId, binding.conversation_id);
    const target: MessagingTarget = {
      account_id: connectionId,
      conversation_id: binding.conversation_id,
      ...(contextToken ? { context_token: contextToken } : {}),
    };
    const state: TypingRun = {
      connectionId,
      target,
      chain: Promise.resolve(),
      stopped: false,
      timer: undefined,
    };
    this.typingRuns.set(runId, state);
    this.queueTyping(runId, state, 1);
    state.timer = setInterval(() => this.queueTyping(runId, state, 1), 8_000);
  }

  async stopTypingForRun(runId: string) {
    const state = this.typingRuns.get(runId);
    if (!state) return;
    this.typingRuns.delete(runId);
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    state.chain = state.chain.then(async () => {
      const adapter = this.adapters.get(state.connectionId);
      if (!(adapter instanceof WeixinAdapter)) return;
      try {
        await adapter.setTyping(state.target, 2);
      } catch (error) {
        this.logTypingFailure(runId, 'stop', error);
      }
    });
    await state.chain;
  }

  async close() {
    await Promise.all([...this.typingRuns.keys()].map((runId) => this.stopTypingForRun(runId)));
    const connectionIds = new Set(this.adapters.keys());
    await Promise.all([...connectionIds].map((id) => this.stop(id, 'shutdown')));
  }

  private queueTyping(runId: string, state: TypingRun, status: 1 | 2) {
    state.chain = state.chain.then(async () => {
      if (state.stopped && status === 1) return;
      const adapter = this.adapters.get(state.connectionId);
      if (!(adapter instanceof WeixinAdapter)) return;
      try {
        await adapter.setTyping(state.target, status);
      } catch (error) {
        this.logTypingFailure(runId, status === 1 ? 'start' : 'stop', error);
      }
    });
  }

  private logTypingFailure(runId: string, action: 'start' | 'stop', error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[messaging] typing ${action} failed run=${runId}: ${message}`);
  }

  private updateStatus(connectionId: string, status: AdapterStatus) {
    this.store.updateConnectionState(connectionId, { state: status.state, error: status.error });
    if (status.state === 'reauth_required' || status.state === 'error') {
      this.adapters.delete(connectionId);
    }
  }

  private async startSafely(connectionId: string, start: () => Promise<unknown>) {
    try {
      await start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[messaging] connection start failed id=${connectionId}: ${message}`);
    }
  }
}

type TypingRun = {
  connectionId: string;
  target: MessagingTarget;
  chain: Promise<void>;
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
};

export type RunPresentation = { title: string; content: string; terminal?: boolean };
export type InteractionPresentation = { title: string; content: string; actions: Array<{ text: string; value: Record<string, unknown> }> };
export type ResolvedInteractionPresentation = { title: string; content: string };
export type RunCardHandle =
  | { platform: 'feishu'; messageId: string }
  | { platform: 'dingtalk'; card: DingTalkCardInstance };
export type InteractionCardHandle = RunCardHandle;

function feishuStatusCard(presentation: RunPresentation) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: presentation.title }, template: 'blue' },
    elements: [{ tag: 'markdown', content: presentation.content }],
  };
}

function feishuInteractionCard(presentation: InteractionPresentation) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: presentation.title }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: presentation.content },
      { tag: 'action', actions: presentation.actions.map((action) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: action.text },
        type: action.value.decision === 'rejected' ? 'danger' : action.value.scope === 'once' || action.value.optionId ? 'primary' : 'default',
        value: action.value,
      })) },
    ],
  };
}

function feishuResolvedInteractionCard(presentation: ResolvedInteractionPresentation) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: presentation.title }, template: 'blue' },
    elements: [{ tag: 'markdown', content: presentation.content }],
  };
}

function dingtalkStatusText(presentation: RunPresentation) {
  return `### ${presentation.title}\n\n${presentation.content}`;
}

function splitText(text: string, limit: number) {
  const characters = Array.from(text);
  const parts: string[] = [];
  for (let index = 0; index < characters.length; index += limit) {
    parts.push(characters.slice(index, index + limit).join(''));
  }
  return parts.length ? parts : [''];
}
