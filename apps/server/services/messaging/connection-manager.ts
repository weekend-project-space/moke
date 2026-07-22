import type { AdapterStatus, MessagingTarget } from '@moke/messaging-core';
import { WeixinAdapter, splitWeixinText, WEIXIN_TEXT_LIMIT, type WeixinOutboundMedia } from '@moke/messaging-weixin';
import { DingTalkAdapter } from '@moke/messaging-dingtalk';
import { JsonMessagingStore } from '../../storage/messaging-store.js';
import { MessagingGateway } from './messaging-gateway.js';

export class MessagingConnectionManager {
  private readonly adapters = new Map<string, WeixinAdapter>();
  private readonly dingtalkAdapters = new Map<string, DingTalkAdapter>();
  private readonly typingRuns = new Map<string, TypingRun>();

  constructor(
    private readonly store: JsonMessagingStore,
    private readonly gateway: MessagingGateway,
  ) {}

  async startAll() {
    for (const connection of this.store.listConnections()) {
      if (connection.enabled) await this.startSafely(connection.id, () => this.start(connection.id));
    }
  }

  async start(connectionId: string) {
    const connection = this.store.getConnection(connectionId);
    if (!connection) return null;
    return connection.platform === 'dingtalk'
      ? this.startDingTalk(connection.id)
      : this.startWeixin(connection.id);
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
    return connection.platform === 'dingtalk'
      ? this.stopDingTalk(connection.id, reason)
      : this.stopWeixin(connection.id, reason);
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
    if (this.dingtalkAdapters.has(connectionId)) return this.store.getPublicConnection(connectionId);
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
    });
    this.dingtalkAdapters.set(connectionId, adapter);
    try {
      await adapter.start({
        account: { id: connection.id, platform: 'dingtalk', name: connection.name, enabled: connection.enabled },
        signal: new AbortController().signal,
        emit: (event) => this.gateway.accept(event),
        updateStatus: (status) => { this.updateStatus(connectionId, status); },
      });
    } catch (error) {
      this.dingtalkAdapters.delete(connectionId);
      throw error;
    }
    return this.store.getPublicConnection(connectionId);
  }

  private async stopDingTalk(connectionId: string, reason: 'user' | 'shutdown' | 'reauth' = 'user') {
    const adapter = this.dingtalkAdapters.get(connectionId);
    if (adapter) {
      await adapter.stop(reason);
      this.dingtalkAdapters.delete(connectionId);
    }
    const record = this.store.getDingTalkConnection(connectionId);
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
      this.dingtalkAdapters.delete(connectionId);
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
    if (binding.platform === 'dingtalk') {
      const adapter = this.dingtalkAdapters.get(connectionId);
      if (!adapter) throw new Error('钉钉连接未启动');
      await adapter.sendText(binding.conversation_id, text);
      this.store.recordOutbound(connectionId, 'dingtalk');
      return;
    }
    await this.sendText(connectionId, binding.conversation_id, text);
  }

  async sendMediaForBinding(connectionId: string, bindingId: string, media: WeixinOutboundMedia, caption?: string, runId?: string) {
    const binding = this.store.getBinding(bindingId);
    if (!binding || binding.account_id !== connectionId) throw new Error('微信会话绑定不存在');
    const adapter = this.adapters.get(connectionId);
    if (!adapter) throw new Error('微信连接未启动');
    const contextToken = this.store.getContextToken(connectionId, binding.conversation_id);
    await adapter.sendMedia({
      account_id: connectionId,
      conversation_id: binding.conversation_id,
      ...(contextToken ? { context_token: contextToken } : {}),
    }, media, caption, runId);
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
    const connectionIds = new Set([...this.adapters.keys(), ...this.dingtalkAdapters.keys()]);
    await Promise.all([...connectionIds].map((id) => this.stop(id, 'shutdown')));
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
      this.dingtalkAdapters.delete(connectionId);
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
