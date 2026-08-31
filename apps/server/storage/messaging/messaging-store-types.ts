import type { MessagingConnectionState, MessagingDeliveryReceipt, MessagingDeliveryResult, MessagingPlatform, OutboundContent } from '@moke/messaging-core';
import type { ImageAttachment } from '@moke/protocol';

export type WeixinConnectionRecord = {
  id: string;
  platform: 'weixin';
  name: string;
  enabled: boolean;
  ilink_bot_id: string;
  user_id?: string;
  api_base_url: string;
  bot_token_secret_ref: string;
  state: MessagingConnectionState;
  created_at: string;
  updated_at: string;
  last_connected_at?: string;
  last_inbound_at?: string;
  last_outbound_at?: string;
  last_error?: { code: string; message: string; at: string };
};

export type PublicWeixinConnection = Omit<WeixinConnectionRecord, 'bot_token_secret_ref'>;

export type DingTalkConnectionRecord = {
  id: string;
  platform: 'dingtalk';
  name: string;
  enabled: boolean;
  client_id: string;
  client_secret_ref: string;
  allowed_user_ids?: string[];
  card_template_id?: string;
  state: MessagingConnectionState;
  created_at: string;
  updated_at: string;
  last_connected_at?: string;
  last_inbound_at?: string;
  last_outbound_at?: string;
  last_event_at?: string;
  last_event_topic?: string;
  last_error?: { code: string; message: string; at: string };
};

export type PublicDingTalkConnection = Omit<DingTalkConnectionRecord, 'client_secret_ref'>;

export type FeishuConnectionRecord = {
  id: string;
  platform: 'feishu';
  name: string;
  enabled: boolean;
  app_id: string;
  app_secret_ref: string;
  domain: 'feishu' | 'lark';
  bot_open_id?: string;
  bot_name?: string;
  bot_avatar_url?: string;
  verified_at?: string;
  state: MessagingConnectionState;
  created_at: string;
  updated_at: string;
  last_connected_at?: string;
  last_inbound_at?: string;
  last_outbound_at?: string;
  last_error?: { code: string; message: string; at: string };
};

export type PublicFeishuConnection = Omit<FeishuConnectionRecord, 'app_secret_ref'>;
export type MessagingConnectionRecord = WeixinConnectionRecord | DingTalkConnectionRecord | FeishuConnectionRecord;
export type PublicMessagingConnection = PublicWeixinConnection | PublicDingTalkConnection | PublicFeishuConnection;

export type MessagingBinding = {
  id: string;
  platform: MessagingPlatform;
  account_id: string;
  conversation_id: string;
  conversation_type: 'direct' | 'group' | 'channel';
  session_id: string;
  created_at: string;
  updated_at: string;
  last_inbound_message_id?: string;
  last_sender_id?: string;
};

export type ContextRecord = {
  peer_user_id: string;
  secret_ref: string;
  source_message_id: string;
  updated_at: string;
};

export type DingTalkReplyContextRecord = {
  conversation_id: string;
  secret_ref: string;
  source_message_id: string;
  expires_at?: string;
  updated_at: string;
};

export type InboundJobState = 'queued' | 'running' | 'delivering' | 'completed' | 'failed';

export type InboundJob = {
  id: string;
  binding_id: string;
  platform_message_id: string;
  text: string;
  attachments?: ImageAttachment[];
  state: InboundJobState;
  run_id?: string;
  error?: string;
  created_at: string;
  updated_at: string;
};

export type StoredOutboundOperation =
  | { kind: 'message'; contents: OutboundContent[]; reply_to_id?: string; workspace_root?: string; approved_roots?: string[] }
  | { kind: 'activity'; active: boolean }
  | { kind: 'status'; phase: 'working' | 'waiting_input' | 'waiting_approval'; title: string; detail?: string }
  | { kind: 'interaction'; interaction_id: string; interaction_kind?: 'ask' | 'approval'; title: string; detail: string; options: Array<{ id: string; label: string }>; resolved?: { label: string } }
  | { kind: 'result'; outcome: 'completed' | 'failed' | 'cancelled'; text: string; message_already_delivered: boolean };

export type OutboundJob = {
  id: string;
  idempotency_key: string;
  content_hash: string;
  coalesce_key?: string;
  binding_id: string;
  inbound_job_id?: string;
  completes_inbound: boolean;
  operation: StoredOutboundOperation;
  state: 'pending' | 'sending' | 'delivered' | 'failed';
  attempt_count: number;
  next_attempt_at: string;
  receipts: MessagingDeliveryReceipt[];
  reference?: Record<string, string>;
  error?: string;
  created_at: string;
  updated_at: string;
};

export type InteractionRecord = {
  id: string;
  run_id: string;
  binding_id: string;
  request_id: string;
  kind: 'ask' | 'approval';
  allowed_sender_id?: string;
  choices: Array<{ id: string; label: string; value: Record<string, string> }>;
  state: 'pending' | 'resolving' | 'resolved' | 'expired';
  result?: Record<string, string>;
  created_at: string;
  updated_at: string;
};

export type EnqueueOutboundInput = {
  idempotencyKey: string;
  bindingId: string;
  operation: StoredOutboundOperation;
  coalesceKey?: string;
  inboundJobId?: string;
  completesInbound?: boolean;
};

export interface MessagingStore {
  initialize(): void;
  listConnections(): PublicMessagingConnection[];
  getConnection(id: string): MessagingConnectionRecord | null;
  getPublicConnection(id: string): PublicMessagingConnection | null;
  getWeixinConnection(id: string): WeixinConnectionRecord | null;
  getPublicWeixinConnection(id: string): PublicWeixinConnection | null;
  createConnection(input: { name: string; ilinkBotId: string; userId?: string; apiBaseUrl: string; token: string }): WeixinConnectionRecord;
  createDingTalkConnection(input: { name?: string; clientId: string; clientSecret: string; allowedUserIds?: string[]; cardTemplateId?: string }): PublicDingTalkConnection;
  createFeishuConnection(input: { name?: string; appId: string; appSecret: string; domain?: 'feishu' | 'lark' }): PublicFeishuConnection;
  updateDingTalkOptions(id: string, input: { allowedUserIds?: string[]; cardTemplateId?: string }): PublicDingTalkConnection;
  updateConnectionState(id: string, input: { state: MessagingConnectionState; error?: { code: string; message: string } }): PublicMessagingConnection;
  setConnectionEnabled(id: string, enabled: boolean): PublicMessagingConnection;
  replaceConnectionAuth(id: string, input: { ilinkBotId: string; userId?: string; apiBaseUrl: string; token: string }): WeixinConnectionRecord;
  deleteConnection(id: string): void;
  getSecret(ref: string): string | undefined;
  getConnectionSecret(connection: MessagingConnectionRecord): string | undefined;
  getAdapterState<T>(connectionId: string, key: string): T | undefined;
  setAdapterState<T>(connectionId: string, key: string, value: T): void;
  deleteAdapterState(connectionId: string, key: string): void;
  findBinding(connectionId: string, conversationId: string, platform?: MessagingPlatform): MessagingBinding | null;
  getBinding(bindingId: string): MessagingBinding | null;
  listBindings(input?: { platform?: MessagingPlatform }): MessagingBinding[];
  createBinding(input: { connectionId: string; conversationId: string; conversationType?: 'direct' | 'group' | 'channel'; sessionId: string; platform?: MessagingPlatform }): MessagingBinding;
  markBindingInbound(bindingId: string, messageId: string, senderId?: string): void;
  recordInbound(connectionId: string, platform?: MessagingPlatform): void;
  recordOutbound(connectionId: string, platform?: MessagingPlatform): void;
  enqueueInboundJob(input: { bindingId: string; platformMessageId: string; text: string; attachments?: ImageAttachment[] }): { status: 'duplicate' } | { status: 'queued'; job: InboundJob };
  claimNextInboundJob(bindingId: string): InboundJob | null;
  setInboundRun(bindingId: string, jobId: string, runId: string): boolean;
  completeInboundJob(bindingId: string, jobId: string): boolean;
  findInboundJobByRun(runId: string): InboundJob | null;
  markInboundDelivering(bindingId: string, jobId: string): boolean;
  failInboundJob(bindingId: string, jobId: string, error: string): boolean;
  listRecoverableInboundBindings(): string[];
  recoverInboundJobs(): void;
  enqueueOutboundJob(input: EnqueueOutboundInput): OutboundJob;
  getOutboundJob(idempotencyKey: string): OutboundJob | null;
  getLatestOutboundReference(bindingId: string, coalesceKey: string): Record<string, string> | undefined;
  hasDeliveredText(bindingId: string, text: string, runId?: string): boolean;
  claimDueOutboundJobs(limit: number, now?: string): OutboundJob[];
  getNextOutboundAttemptAt(): string | undefined;
  completeOutboundJob(id: string, result: MessagingDeliveryResult): { job: OutboundJob; releasedBindingId?: string };
  retryOutboundJob(id: string, error: string, nextAttemptAt: string): OutboundJob;
  failOutboundJob(id: string, error: string): { job: OutboundJob; releasedBindingId?: string };
  recoverOutboundJobs(): void;
  createInteraction(input: Omit<InteractionRecord, 'id' | 'state' | 'created_at' | 'updated_at'>): InteractionRecord;
  getInteraction(id: string): InteractionRecord | null;
  findInteraction(runId: string, requestId: string): InteractionRecord | null;
  findPendingInteraction(bindingId: string, kind: InteractionRecord['kind']): InteractionRecord | null;
  claimInteraction(id: string): InteractionRecord | null;
  resolveInteraction(id: string, result: Record<string, string>): InteractionRecord;
  releaseInteraction(id: string): void;
  expireRunInteractions(runId: string): InteractionRecord[];
}
