import type { AdapterStatus, MessagingTarget } from '@moke/messaging-core';
import { WeixinAdapter, splitWeixinText, WEIXIN_TEXT_LIMIT, type WeixinOutboundMedia } from '@moke/messaging-weixin';
import { JsonMessagingStore } from '../../storage/messaging-store.js';
import { MessagingGateway } from './messaging-gateway.js';

export class MessagingConnectionManager {
  private readonly adapters = new Map<string, WeixinAdapter>();
  private readonly typingRuns = new Map<string, TypingRun>();

  constructor(
    private readonly store: JsonMessagingStore,
    private readonly gateway: MessagingGateway,
  ) {}

  async startAll() {
    for (const connection of this.store.listConnections()) {
      if (connection.enabled) await this.start(connection.id);
    }
  }

  async start(connectionId: string) {
    if (this.adapters.has(connectionId)) return this.store.getPublicConnection(connectionId);
    const connection = this.store.getConnection(connectionId);
    if (!connection) throw new Error('Messaging connection not found');
    const token = this.store.getToken(connection);
    if (!token) {
      this.store.updateConnectionState(connectionId, {
        state: 'reauth_required',
        error: { code: 'WEIXIN_AUTH_MISSING', message: '微信授权凭据缺失，请重新授权' },
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
    await adapter.start({
      account: { id: connection.id, platform: 'weixin', name: connection.name, enabled: connection.enabled },
      signal: new AbortController().signal,
      emit: (event) => this.gateway.accept(event),
      updateStatus: (status) => this.updateStatus(connection.id, status),
    });
    return this.store.getPublicConnection(connectionId);
  }

  async stop(connectionId: string, reason: 'user' | 'shutdown' = 'user') {
    const adapter = this.adapters.get(connectionId);
    if (adapter) {
      await adapter.stop(reason);
      this.adapters.delete(connectionId);
    }
    const record = this.store.getConnection(connectionId);
    if (record && record.state !== 'reauth_required' && record.state !== 'error') {
      this.store.updateConnectionState(connectionId, { state: 'stopped' });
    }
    return this.store.getPublicConnection(connectionId);
  }

  async remove(connectionId: string) {
    await this.stop(connectionId);
    this.store.deleteConnection(connectionId);
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
    if (!binding || binding.account_id !== connectionId) throw new Error('微信会话绑定不存在');
    await this.sendText(connectionId, binding.conversation_id, text);
  }

  async sendMediaForBinding(connectionId: string, bindingId: string, media: WeixinOutboundMedia, caption?: string) {
    const binding = this.store.getBinding(bindingId);
    if (!binding || binding.account_id !== connectionId) throw new Error('微信会话绑定不存在');
    const adapter = this.adapters.get(connectionId);
    if (!adapter) throw new Error('微信连接未启动');
    const contextToken = this.store.getContextToken(connectionId, binding.conversation_id);
    await adapter.sendMedia({
      account_id: connectionId,
      conversation_id: binding.conversation_id,
      ...(contextToken ? { context_token: contextToken } : {}),
    }, media, caption);
    this.store.recordOutbound(connectionId);
  }

  startTypingForBinding(connectionId: string, bindingId: string, runId: string) {
    if (this.typingRuns.has(runId)) return;
    const binding = this.store.getBinding(bindingId);
    const adapter = this.adapters.get(connectionId);
    if (!binding || binding.account_id !== connectionId || !adapter) return;
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
      if (!adapter) return;
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
    await Promise.all([...this.adapters.keys()].map((id) => this.stop(id, 'shutdown')));
  }

  private queueTyping(runId: string, state: TypingRun, status: 1 | 2) {
    state.chain = state.chain.then(async () => {
      if (state.stopped && status === 1) return;
      const adapter = this.adapters.get(state.connectionId);
      if (!adapter) return;
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
}

type TypingRun = {
  connectionId: string;
  target: MessagingTarget;
  chain: Promise<void>;
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
};
