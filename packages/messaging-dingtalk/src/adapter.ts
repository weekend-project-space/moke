import { DWClient, EventAck, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';

import type { AdapterContext, AdapterStatus } from '@moke/messaging-core';
import { dingtalkCapabilities } from './constants.js';
import { toDingTalkInboundMessage } from './message-converter.js';

export type DingTalkAdapterConfig = {
  accountId: string;
  clientId: string;
  clientSecret: string;
  saveReplyContext(input: { conversationId: string; sessionWebhook: string; sourceMessageId: string; expiresAt?: string }): Promise<void>;
  loadReplyContext(conversationId: string): { sessionWebhook?: string; expiresAt?: string } | null;
  recordStreamEvent?(topic: string): void | Promise<void>;
  fetcher?: typeof fetch;
};

export class DingTalkAdapter {
  readonly platform = 'dingtalk' as const;
  readonly capabilities = dingtalkCapabilities;
  private client: DWClient | undefined;
  private status: AdapterStatus = { state: 'stopped', changed_at: new Date().toISOString() };

  constructor(private readonly config: DingTalkAdapterConfig) {}

  async start(context: AdapterContext) {
    if (this.client) return;
    this.setStatus(context, { state: 'starting', changed_at: new Date().toISOString() });
    const client = new DWClient({ clientId: this.config.clientId, clientSecret: this.config.clientSecret });
    client.registerCallbackListener(TOPIC_ROBOT, (event) => {
      void this.handleBotMessage(context, event);
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

  async sendText(conversationId: string, text: string) {
    const context = this.config.loadReplyContext(conversationId);
    if (!context?.sessionWebhook || (context.expiresAt && Date.parse(context.expiresAt) <= Date.now())) throw new Error('CONVERSATION_CONTEXT_EXPIRED: Send another message in DingTalk to refresh the conversation context');
    const response = await (this.config.fetcher || fetch)(context.sessionWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: text } }) });
    if (!response.ok) throw new Error(`DINGTALK_SEND_FAILED: HTTP ${response.status}`);
  }

  private async handleBotMessage(context: AdapterContext, event: DWClientDownStream) {
    await this.config.recordStreamEvent?.(event.headers.topic);
    const inbound = toDingTalkInboundMessage({ accountId: this.config.accountId, eventId: event.headers.eventId || event.headers.messageId, message: JSON.parse(event.data) });
    if (!inbound) return;
    if (inbound.replyContext) await this.config.saveReplyContext(inbound.replyContext);
    await context.emit(inbound.event);
  }

  private setStatus(context: AdapterContext, status: AdapterStatus) { this.status = status; void context.updateStatus(status); }
}
