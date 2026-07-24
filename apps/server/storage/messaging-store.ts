import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { MessagingConnectionState, MessagingDeliveryReceipt, MessagingDeliveryResult, MessagingPlatform, OutboundContent } from '@moke/messaging-core';
import type { ImageAttachment } from '@moke/protocol';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

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

type ContextRecord = {
  peer_user_id: string;
  secret_ref: string;
  source_message_id: string;
  updated_at: string;
};

type DingTalkReplyContextRecord = {
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
  | { kind: 'message'; contents: OutboundContent[]; reply_to_id?: string }
  | { kind: 'activity'; active: boolean }
  | { kind: 'status'; phase: 'working' | 'waiting_input' | 'waiting_approval'; title: string; detail?: string }
  | { kind: 'interaction'; interaction_id: string; title: string; detail: string; options: Array<{ id: string; label: string }>; resolved?: { label: string } }
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
  createBinding(input: { connectionId: string; conversationId: string; conversationType?: 'direct' | 'group' | 'channel'; sessionId: string; platform?: MessagingPlatform }): MessagingBinding;
  markBindingInbound(bindingId: string, messageId: string, senderId?: string): void;
  recordInbound(connectionId: string, platform?: MessagingPlatform): void;
  recordOutbound(connectionId: string, platform?: MessagingPlatform): void;
  enqueueInboundJob(input: { bindingId: string; platformMessageId: string; text: string; attachments?: ImageAttachment[] }): { status: 'duplicate' } | { status: 'queued'; job: InboundJob };
  claimNextInboundJob(bindingId: string): InboundJob | null;
  setInboundRun(bindingId: string, jobId: string, runId: string): boolean;
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
  claimInteraction(id: string): InteractionRecord | null;
  resolveInteraction(id: string, result: Record<string, string>): InteractionRecord;
  releaseInteraction(id: string): void;
  expireRunInteractions(runId: string): InteractionRecord[];
}

export class JsonMessagingStore implements MessagingStore {
  private readonly root: string;
  private readonly connectionsPath: string;
  private readonly bindingsPath: string;
  private readonly secretsPath: string;
  private readonly weixinPath: string;
  private readonly dingtalkPath: string;
  private readonly feishuPath: string;

  constructor(storePath: string) {
    this.root = join(storePath, 'messaging');
    this.connectionsPath = join(this.root, 'connections');
    this.bindingsPath = join(this.root, 'bindings', 'index.json');
    this.secretsPath = join(this.root, 'secrets');
    this.weixinPath = join(this.root, 'weixin');
    this.dingtalkPath = join(this.root, 'dingtalk');
    this.feishuPath = join(this.root, 'feishu');
  }

  initialize() {
    mkdirSync(this.connectionsPath, { recursive: true });
    mkdirSync(dirname(this.bindingsPath), { recursive: true });
    mkdirSync(this.secretsPath, { recursive: true });
    mkdirSync(this.weixinPath, { recursive: true });
    mkdirSync(this.dingtalkPath, { recursive: true });
    mkdirSync(this.feishuPath, { recursive: true });
    mkdirSync(this.inboundJobsPath(), { recursive: true });
    mkdirSync(this.outboundJobsPath(), { recursive: true });
    mkdirSync(this.interactionsPath(), { recursive: true });
    mkdirSync(this.adapterStatesPath(), { recursive: true });
    if (!existsSync(this.connectionsIndexPath())) writeJson(this.connectionsIndexPath(), []);
    if (!existsSync(this.bindingsPath)) writeJson(this.bindingsPath, []);
    this.validateReadableStore();
    this.migrateLegacyQueues();
    this.migrateAdapterState();
  }

  listConnections() {
    return this.readConnectionIds()
      .map((id) => this.getConnection(id))
      .filter((record): record is MessagingConnectionRecord => !!record)
      .map(toPublicConnection);
  }

  getConnection(id: string) {
    assertId(id);
    const path = this.connectionPath(id);
    const record = readJson<unknown>(path, null);
    if (record === null && !existsSync(path)) return null;
    if (!isWeixinConnection(record) && !isDingTalkConnection(record) && !isFeishuConnection(record)) {
      throw new MessagingStoreCorruptionError(path, 'expected a valid messaging connection');
    }
    return record;
  }

  getPublicConnection(id: string) {
    const record = this.getConnection(id);
    return record ? toPublicConnection(record) : null;
  }

  getWeixinConnection(id: string) {
    const record = this.getConnection(id);
    return record?.platform === 'weixin' ? record : null;
  }

  getPublicWeixinConnection(id: string) {
    const record = this.getWeixinConnection(id);
    return record ? toPublicConnection(record) : null;
  }

  getDingTalkConnection(id: string) {
    const record = this.getConnection(id);
    return record?.platform === 'dingtalk' ? record : null;
  }

  getFeishuConnection(id: string) {
    const record = this.getConnection(id);
    return record?.platform === 'feishu' ? record : null;
  }

  createConnection(input: {
    name: string;
    ilinkBotId: string;
    userId?: string;
    apiBaseUrl: string;
    token: string;
  }) {
    const now = new Date().toISOString();
    const id = `wxconn_${randomUUID().slice(0, 8)}`;
    const secretRef = `secret_${id}`;
    const record: WeixinConnectionRecord = {
      id,
      platform: 'weixin',
      name: input.name.trim() || 'WeChat',
      enabled: true,
      ilink_bot_id: input.ilinkBotId,
      ...(input.userId ? { user_id: input.userId } : {}),
      api_base_url: input.apiBaseUrl,
      bot_token_secret_ref: secretRef,
      state: 'stopped',
      created_at: now,
      updated_at: now,
    };
    this.writeSecret(secretRef, input.token);
    writeJson(this.connectionPath(id), record);
    writeJson(this.connectionsIndexPath(), [...this.readConnectionIds(), id]);
    return record;
  }

  createDingTalkConnection(input: { name?: string; clientId: string; clientSecret: string; allowedUserIds?: string[]; cardTemplateId?: string }) {
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (!clientId || !clientSecret) throw new Error('DingTalk client id and client secret are required');
    const now = new Date().toISOString();
    const id = `dtconn_${randomUUID().slice(0, 8)}`;
    const secretRef = `secret_${id}`;
    const record: DingTalkConnectionRecord = {
      id,
      platform: 'dingtalk',
      name: input.name?.trim() || 'DingTalk',
      enabled: true,
      client_id: clientId,
      client_secret_ref: secretRef,
      ...(input.allowedUserIds?.length ? { allowed_user_ids: normalizeStringList(input.allowedUserIds) } : {}),
      ...(input.cardTemplateId?.trim() ? { card_template_id: input.cardTemplateId.trim() } : {}),
      state: 'stopped',
      created_at: now,
      updated_at: now,
    };
    this.writeSecret(secretRef, clientSecret);
    writeJson(this.connectionPath(id), record);
    writeJson(this.connectionsIndexPath(), [...this.readConnectionIds(), id]);
    return toPublicConnection(record);
  }

  updateDingTalkOptions(id: string, input: { allowedUserIds?: string[]; cardTemplateId?: string }) {
    const record = this.getDingTalkConnection(id);
    if (!record) throw new Error('DingTalk connection not found');
    if (input.allowedUserIds !== undefined) record.allowed_user_ids = normalizeStringList(input.allowedUserIds);
    if (input.cardTemplateId !== undefined) record.card_template_id = input.cardTemplateId.trim() || undefined;
    record.updated_at = new Date().toISOString();
    writeJson(this.connectionPath(id), record);
    return toPublicConnection(record);
  }

  createFeishuConnection(input: {
    name?: string;
    appId: string;
    appSecret: string;
    domain?: 'feishu' | 'lark';
  }) {
    const appId = input.appId.trim();
    const appSecret = input.appSecret.trim();
    if (!appId || !appSecret) throw new Error('Feishu app id and app secret are required');
    const now = new Date().toISOString();
    const id = `fsconn_${randomUUID().slice(0, 8)}`;
    const secretRef = `secret_${id}`;
    const record: FeishuConnectionRecord = {
      id,
      platform: 'feishu',
      name: input.name?.trim() || 'Feishu',
      enabled: true,
      app_id: appId,
      app_secret_ref: secretRef,
      domain: input.domain === 'lark' ? 'lark' : 'feishu',
      state: 'stopped',
      created_at: now,
      updated_at: now,
    };
    this.writeSecret(secretRef, appSecret);
    writeJson(this.connectionPath(id), record);
    writeJson(this.connectionsIndexPath(), [...this.readConnectionIds(), id]);
    return toPublicConnection(record);
  }

  getConnectionSecret(connection: MessagingConnectionRecord) {
    return this.getSecret(connectionSecretRef(connection));
  }

  getSecret(ref: string) {
    return this.readSecret(ref);
  }

  updateFeishuIdentity(id: string, identity: { openId: string; name: string; avatarUrl?: string }) {
    const record = this.getFeishuConnection(id);
    if (!record) throw new Error('Feishu connection not found');
    const now = new Date().toISOString();
    record.bot_open_id = identity.openId;
    record.bot_name = identity.name;
    record.bot_avatar_url = identity.avatarUrl;
    record.verified_at = now;
    record.updated_at = now;
    writeJson(this.connectionPath(id), record);
    return toPublicConnection(record);
  }

  updateConnectionState(id: string, input: {
    state: MessagingConnectionState;
    error?: { code: string; message: string };
  }) {
    const record = this.requireConnection(id);
    const now = new Date().toISOString();
    record.state = input.state;
    record.updated_at = now;
    if (input.state === 'connected') record.last_connected_at = now;
    record.last_error = input.error ? { ...input.error, at: now } : undefined;
    writeJson(this.connectionPath(id), record);
    return toPublicConnection(record);
  }

  setConnectionEnabled(id: string, enabled: boolean) {
    const record = this.requireConnection(id);
    record.enabled = enabled;
    record.updated_at = new Date().toISOString();
    writeJson(this.connectionPath(id), record);
    return toPublicConnection(record);
  }

  replaceConnectionAuth(id: string, input: { ilinkBotId: string; userId?: string; apiBaseUrl: string; token: string }) {
    const record = this.requireWeixinConnection(id);
    record.ilink_bot_id = input.ilinkBotId;
    record.user_id = input.userId;
    record.api_base_url = input.apiBaseUrl;
    record.enabled = true;
    record.updated_at = new Date().toISOString();
    this.writeSecret(record.bot_token_secret_ref, input.token);
    writeJson(this.connectionPath(id), record);
    return record;
  }

  deleteConnection(id: string) {
    const record = this.requireConnection(id);
    const bindings = this.readBindings();
    const removedBindings = bindings.filter((binding) => binding.account_id === id);
    const platformPath = this.platformConnectionPath(id, record.platform);

    for (const secretRef of this.readPlatformSecretRefs(record)) {
      rmSync(this.secretPath(secretRef), { force: true });
    }
    for (const binding of removedBindings) {
      rmSync(this.inboundJobPath(binding.id), { force: true });
      for (const outbound of this.readOutboundJobs().filter((job) => job.binding_id === binding.id)) {
        rmSync(this.outboundJobPath(outbound.id), { force: true });
      }
      for (const interaction of this.readInteractions().filter((item) => item.binding_id === binding.id)) {
        rmSync(this.interactionPath(interaction.id), { force: true });
      }
    }
    rmSync(this.connectionPath(id), { force: true });
    rmSync(platformPath, { recursive: true, force: true });
    rmSync(this.adapterStatePath(id), { force: true });
    rmSync(this.secretPath(connectionSecretRef(record)), { force: true });
    writeJson(this.connectionsIndexPath(), this.readConnectionIds().filter((candidate) => candidate !== id));
    writeJson(this.bindingsPath, bindings.filter((binding) => binding.account_id !== id));
  }

  getAdapterState<T>(connectionId: string, key: string) {
    assertId(connectionId);
    return this.readAdapterState(connectionId)[key] as T | undefined;
  }

  setAdapterState<T>(connectionId: string, key: string, value: T) {
    assertId(connectionId);
    const state = this.readAdapterState(connectionId);
    state[key] = value;
    writeJson(this.adapterStatePath(connectionId), state);
  }

  deleteAdapterState(connectionId: string, key: string) {
    assertId(connectionId);
    const state = this.readAdapterState(connectionId);
    if (!(key in state)) return;
    delete state[key];
    writeJson(this.adapterStatePath(connectionId), state);
  }

  findBinding(connectionId: string, conversationId: string, platform: MessagingPlatform = 'weixin') {
    return this.readBindings().find((binding) =>
      binding.platform === platform && binding.account_id === connectionId && binding.conversation_id === conversationId) || null;
  }

  getBinding(bindingId: string) {
    return this.readBindings().find((binding) => binding.id === bindingId) || null;
  }

  createBinding(input: {
    connectionId: string;
    conversationId: string;
    conversationType?: 'direct' | 'group' | 'channel';
    sessionId: string;
    platform?: MessagingPlatform;
  }) {
    const now = new Date().toISOString();
    const binding: MessagingBinding = {
      id: `bind_${randomUUID().slice(0, 8)}`,
      platform: input.platform || 'weixin',
      account_id: input.connectionId,
      conversation_id: input.conversationId,
      conversation_type: input.conversationType || 'direct',
      session_id: input.sessionId,
      created_at: now,
      updated_at: now,
    };
    writeJson(this.bindingsPath, [...this.readBindings(), binding]);
    return binding;
  }

  markBindingInbound(bindingId: string, messageId: string, senderId?: string) {
    const bindings = this.readBindings();
    const binding = bindings.find((candidate) => candidate.id === bindingId);
    if (!binding) return;
    binding.last_inbound_message_id = messageId;
    if (senderId?.trim()) binding.last_sender_id = senderId.trim();
    binding.updated_at = new Date().toISOString();
    writeJson(this.bindingsPath, bindings);
  }

  recordInbound(connectionId: string, platform: MessagingPlatform = 'weixin') {
    const record = this.requirePlatformConnection(connectionId, platform);
    record.last_inbound_at = new Date().toISOString();
    record.updated_at = record.last_inbound_at;
    writeJson(this.connectionPath(connectionId), record);
  }

  recordOutbound(connectionId: string, platform: MessagingPlatform = 'weixin') {
    const record = this.requirePlatformConnection(connectionId, platform);
    record.last_outbound_at = new Date().toISOString();
    record.updated_at = record.last_outbound_at;
    writeJson(this.connectionPath(connectionId), record);
  }

  enqueueInboundJob(input: {
    bindingId: string;
    platformMessageId: string;
    text: string;
    attachments?: ImageAttachment[];
  }) {
    const queue = this.readInboundJobs(input.bindingId);
    if (queue.some((job) => job.platform_message_id === input.platformMessageId)) return { status: 'duplicate' as const };
    const now = new Date().toISOString();
    const job: InboundJob = {
      id: `in_${randomUUID().slice(0, 12)}`,
      binding_id: input.bindingId,
      platform_message_id: input.platformMessageId,
      text: input.text,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      state: 'queued',
      created_at: now,
      updated_at: now,
    };
    queue.push(job);
    this.writeInboundJobs(input.bindingId, queue);
    return { status: 'queued' as const, job };
  }

  claimNextInboundJob(bindingId: string) {
    const queue = this.readInboundJobs(bindingId);
    if (queue.some((job) => job.state === 'running' || job.state === 'delivering')) return null;
    const job = queue.find((candidate) => candidate.state === 'queued');
    if (!job) return null;
    job.state = 'running';
    job.updated_at = new Date().toISOString();
    this.writeInboundJobs(bindingId, queue);
    return job;
  }

  setInboundRun(bindingId: string, jobId: string, runId: string) {
    return this.updateInboundJob(bindingId, jobId, (job) => {
      if (job.state !== 'running') return false;
      job.run_id = runId;
      return true;
    });
  }

  getInboundJob(bindingId: string, jobId: string) {
    return this.readInboundJobs(bindingId).find((job) => job.id === jobId) || null;
  }

  findInboundJobByRun(runId: string) {
    for (const bindingId of this.listInboundJobBindingIds()) {
      const job = this.readInboundJobs(bindingId).find((candidate) => candidate.run_id === runId);
      if (job) return job;
    }
    return null;
  }

  markInboundDelivering(bindingId: string, jobId: string) {
    return this.updateInboundJob(bindingId, jobId, (job) => {
      if (job.state !== 'running') return false;
      job.state = 'delivering';
      return true;
    });
  }

  completeInboundJob(bindingId: string, jobId: string) {
    return this.updateInboundJob(bindingId, jobId, (job) => {
      if (job.state !== 'delivering' && job.state !== 'running') return false;
      job.state = 'completed';
      job.error = undefined;
      return true;
    });
  }

  failInboundJob(bindingId: string, jobId: string, error: string) {
    return this.updateInboundJob(bindingId, jobId, (job) => {
      if (job.state === 'completed' || job.state === 'failed') return false;
      job.state = 'failed';
      job.error = error.slice(0, 500);
      return true;
    });
  }

  listRecoverableInboundBindings() {
    return this.listInboundJobBindingIds().filter((bindingId) => this.readInboundJobs(bindingId)
      .some((job) => job.state === 'queued' || job.state === 'running' || job.state === 'delivering'));
  }

  recoverInboundJobs() {
    const outboundJobs = this.readOutboundJobs();
    for (const bindingId of this.listInboundJobBindingIds()) {
      const jobs = this.readInboundJobs(bindingId);
      let changed = false;
      for (const job of jobs) {
        if (job.state === 'running') {
          job.state = 'failed';
          job.error = 'Server restarted before the agent run completed';
          job.updated_at = new Date().toISOString();
          changed = true;
          continue;
        }
        if (job.state !== 'delivering') continue;
        const related = outboundJobs.filter((outbound) => outbound.inbound_job_id === job.id && outbound.completes_inbound);
        const terminal = related.find((outbound) => outbound.state === 'delivered' || outbound.state === 'failed');
        if (!terminal && related.length === 0) {
          job.state = 'failed';
          job.error = 'Server restarted before the final delivery was scheduled';
          job.updated_at = new Date().toISOString();
          changed = true;
          continue;
        }
        if (!terminal) continue;
        job.state = terminal.state === 'delivered' ? 'completed' : 'failed';
        job.error = terminal.state === 'failed' ? terminal.error || 'Messaging delivery failed' : undefined;
        job.updated_at = new Date().toISOString();
        changed = true;
      }
      if (changed) this.writeInboundJobs(bindingId, jobs);
    }
  }

  enqueueOutboundJob(input: EnqueueOutboundInput) {
    const contentHash = hashOutboundOperation(input.operation);
    const existing = this.getOutboundJob(input.idempotencyKey);
    if (existing) {
      if (existing.binding_id !== input.bindingId || existing.content_hash !== contentHash) {
        throw new Error('Idempotency key belongs to a different messaging outbound operation');
      }
      return existing;
    }
    if (input.coalesceKey) {
      const pending = this.findOutboundByCoalesceKey(input.bindingId, input.coalesceKey, 'pending');
      if (pending) {
        pending.idempotency_key = input.idempotencyKey;
        pending.content_hash = contentHash;
        pending.operation = input.operation;
        pending.inbound_job_id = input.inboundJobId;
        pending.completes_inbound = !!input.completesInbound;
        pending.updated_at = new Date().toISOString();
        writeJson(this.outboundJobPath(pending.id), pending);
        return pending;
      }
    }
    const now = new Date().toISOString();
    const job: OutboundJob = {
      id: `out_${randomUUID().slice(0, 12)}`,
      idempotency_key: input.idempotencyKey,
      content_hash: contentHash,
      ...(input.coalesceKey ? { coalesce_key: input.coalesceKey } : {}),
      binding_id: input.bindingId,
      ...(input.inboundJobId ? { inbound_job_id: input.inboundJobId } : {}),
      completes_inbound: !!input.completesInbound,
      operation: input.operation,
      state: 'pending',
      attempt_count: 0,
      next_attempt_at: now,
      receipts: [],
      created_at: now,
      updated_at: now,
    };
    writeJson(this.outboundJobPath(job.id), job);
    return job;
  }

  getOutboundJob(idempotencyKey: string) {
    return this.readOutboundJobs().find((job) => job.idempotency_key === idempotencyKey) || null;
  }

  getLatestOutboundReference(bindingId: string, coalesceKey: string) {
    const jobs = this.readOutboundJobs()
      .filter((job) => job.binding_id === bindingId && job.coalesce_key === coalesceKey && job.reference)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return jobs[0]?.reference;
  }

  hasDeliveredText(bindingId: string, text: string, runId?: string) {
    return this.readOutboundJobs().some((job) => {
      if (job.binding_id !== bindingId || job.state !== 'delivered') return false;
      if (runId && job.operation.kind === 'result') return false;
      return job.operation.kind === 'message' && job.operation.contents.some((content) => content.type === 'text' && content.text.trim() === text.trim());
    });
  }

  claimDueOutboundJobs(limit: number, now = new Date().toISOString()) {
    const due = this.readOutboundJobs()
      .filter((job) => job.state === 'pending' && job.next_attempt_at <= now)
      .sort((left, right) => left.next_attempt_at.localeCompare(right.next_attempt_at))
      .slice(0, Math.max(0, limit));
    for (const job of due) {
      job.state = 'sending';
      job.updated_at = new Date().toISOString();
      writeJson(this.outboundJobPath(job.id), job);
    }
    return due;
  }

  getNextOutboundAttemptAt() {
    return this.readOutboundJobs()
      .filter((job) => job.state === 'pending')
      .sort((left, right) => left.next_attempt_at.localeCompare(right.next_attempt_at))[0]?.next_attempt_at;
  }

  completeOutboundJob(id: string, result: MessagingDeliveryResult) {
    const job = this.getOutboundJobById(id);
    if (!job) throw new Error(`Messaging outbound job is missing: ${id}`);
    job.state = 'delivered';
    job.receipts = result.receipts;
    job.reference = result.reference;
    job.error = undefined;
    job.updated_at = new Date().toISOString();
    writeJson(this.outboundJobPath(job.id), job);
    const releasedBindingId = this.releaseInboundForOutbound(job, 'completed');
    return { job, ...(releasedBindingId ? { releasedBindingId } : {}) };
  }

  retryOutboundJob(id: string, error: string, nextAttemptAt: string) {
    const job = this.getOutboundJobById(id);
    if (!job) throw new Error(`Messaging outbound job is missing: ${id}`);
    job.state = 'pending';
    job.attempt_count += 1;
    job.error = error.slice(0, 500);
    job.next_attempt_at = nextAttemptAt;
    job.updated_at = new Date().toISOString();
    writeJson(this.outboundJobPath(job.id), job);
    return job;
  }

  failOutboundJob(id: string, error: string) {
    const job = this.getOutboundJobById(id);
    if (!job) throw new Error(`Messaging outbound job is missing: ${id}`);
    job.state = 'failed';
    job.attempt_count += 1;
    job.error = error.slice(0, 500);
    job.updated_at = new Date().toISOString();
    writeJson(this.outboundJobPath(job.id), job);
    const releasedBindingId = this.releaseInboundForOutbound(job, 'failed');
    return { job, ...(releasedBindingId ? { releasedBindingId } : {}) };
  }

  recoverOutboundJobs() {
    const now = new Date().toISOString();
    for (const job of this.readOutboundJobs()) {
      if (job.state !== 'sending') continue;
      job.state = 'pending';
      job.next_attempt_at = now;
      job.updated_at = now;
      writeJson(this.outboundJobPath(job.id), job);
    }
  }

  createInteraction(input: Omit<InteractionRecord, 'id' | 'state' | 'created_at' | 'updated_at'>) {
    const now = new Date().toISOString();
    const record: InteractionRecord = {
      id: `int_${randomUUID().slice(0, 12)}`,
      ...input,
      state: 'pending',
      created_at: now,
      updated_at: now,
    };
    writeJson(this.interactionPath(record.id), record);
    return record;
  }

  getInteraction(id: string) {
    const value = readJson<unknown>(this.interactionPath(id), null);
    return isInteractionRecord(value) ? value : null;
  }

  findInteraction(runId: string, requestId: string) {
    return this.readInteractions().find((record) => record.run_id === runId && record.request_id === requestId) || null;
  }

  claimInteraction(id: string) {
    const interaction = this.getInteraction(id);
    if (!interaction || interaction.state !== 'pending') return null;
    interaction.state = 'resolving';
    interaction.updated_at = new Date().toISOString();
    writeJson(this.interactionPath(id), interaction);
    return interaction;
  }

  resolveInteraction(id: string, result: Record<string, string>) {
    const interaction = this.getInteraction(id);
    if (!interaction) throw new Error(`Messaging interaction is missing: ${id}`);
    interaction.state = 'resolved';
    interaction.result = result;
    interaction.updated_at = new Date().toISOString();
    writeJson(this.interactionPath(id), interaction);
    return interaction;
  }

  releaseInteraction(id: string) {
    const interaction = this.getInteraction(id);
    if (!interaction || interaction.state !== 'resolving') return;
    interaction.state = 'pending';
    interaction.updated_at = new Date().toISOString();
    writeJson(this.interactionPath(id), interaction);
  }

  expireRunInteractions(runId: string) {
    const records = this.readInteractions().filter((record) => record.run_id === runId && record.state === 'pending');
    for (const record of records) {
      record.state = 'expired';
      record.updated_at = new Date().toISOString();
      writeJson(this.interactionPath(record.id), record);
    }
    return records;
  }

  private releaseInboundForOutbound(job: OutboundJob, state: 'completed' | 'failed') {
    if (!job.completes_inbound || !job.inbound_job_id) return undefined;
    const updated = state === 'completed'
      ? this.completeInboundJob(job.binding_id, job.inbound_job_id)
      : this.failInboundJob(job.binding_id, job.inbound_job_id, job.error || 'Messaging delivery failed');
    return updated ? job.binding_id : undefined;
  }

  private readConnectionIds() {
    const ids = readJson<unknown>(this.connectionsIndexPath(), []);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !SAFE_ID.test(id))) {
      throw new MessagingStoreCorruptionError(this.connectionsIndexPath(), 'expected an array of safe connection ids');
    }
    return ids as string[];
  }

  private validateReadableStore() {
    const connectionIds = this.readConnectionIds();
    this.readBindings();
    for (const bindingId of this.listInboundJobBindingIds()) this.readInboundJobs(bindingId);
    this.readOutboundJobs();
    this.readInteractions();
    for (const connectionId of connectionIds) this.readAdapterState(connectionId);
  }

  private migrateAdapterState() {
    for (const connection of this.readConnectionIds().map((id) => this.getConnection(id)).filter((item): item is MessagingConnectionRecord => !!item)) {
      const state = this.readAdapterState(connection.id);
      let changed = false;
      if (connection.platform === 'weixin') {
        if (state['weixin.cursor'] === undefined) {
          const cursor = readJson<{ cursor?: string }>(join(this.weixinConnectionPath(connection.id), 'sync.json'), {}).cursor;
          if (cursor) {
            state['weixin.cursor'] = cursor;
            changed = true;
          }
        }
        for (const [peer, record] of Object.entries(this.readContextRecords(connection.id))) {
          const token = this.readSecret(record.secret_ref);
          if (token && state[`weixin.context:${peer}`] === undefined) {
            state[`weixin.context:${peer}`] = token;
            changed = true;
          }
        }
      }
      if (connection.platform === 'dingtalk') {
        for (const [conversation, record] of Object.entries(this.readDingTalkReplyContexts(connection.id))) {
          const webhook = this.readSecret(record.secret_ref);
          if (webhook && state[`dingtalk.reply:${conversation}`] === undefined) {
            state[`dingtalk.reply:${conversation}`] = {
              sessionWebhook: webhook,
              ...(record.expires_at ? { expiresAt: record.expires_at } : {}),
            };
            changed = true;
          }
        }
      }
      if (changed) writeJson(this.adapterStatePath(connection.id), state);
    }
  }

  private migrateLegacyQueues() {
    const path = join(this.root, 'queues');
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const bindingId = entry.name.slice(0, -'.json'.length);
      if (!SAFE_ID.test(bindingId) || existsSync(this.inboundJobPath(bindingId))) continue;
      const legacy = readJson<{ active?: unknown; pending?: unknown }>(join(path, entry.name), {});
      const now = new Date().toISOString();
      const jobs = [legacy.active, ...(Array.isArray(legacy.pending) ? legacy.pending : [])]
        .map((value, index): InboundJob | null => {
          if (!value || typeof value !== 'object') return null;
          const item = value as { message_id?: unknown; content?: unknown; attachments?: unknown; run_id?: unknown; created_at?: unknown };
          if (typeof item.message_id !== 'string' || typeof item.content !== 'string') return null;
          const wasActive = index === 0 && !!legacy.active;
          return {
            id: `in_${randomUUID().slice(0, 12)}`,
            binding_id: bindingId,
            platform_message_id: item.message_id,
            text: item.content,
            ...(Array.isArray(item.attachments) ? { attachments: item.attachments.filter(isImageAttachment) } : {}),
            state: wasActive ? 'failed' : 'queued',
            ...(wasActive ? { run_id: typeof item.run_id === 'string' ? item.run_id : undefined, error: 'Migrated from an interrupted legacy queue' } : {}),
            created_at: typeof item.created_at === 'string' ? item.created_at : now,
            updated_at: now,
          };
        })
        .filter((job): job is InboundJob => job !== null);
      if (jobs.length) this.writeInboundJobs(bindingId, jobs);
      rmSync(join(path, entry.name), { force: true });
    }
  }

  private readBindings() {
    const bindings = readJson<unknown>(this.bindingsPath, []);
    if (!Array.isArray(bindings) || bindings.some((binding) => !isBinding(binding))) {
      throw new MessagingStoreCorruptionError(this.bindingsPath, 'expected an array of valid bindings');
    }
    return bindings.map((binding) => ({ ...binding, conversation_type: binding.conversation_type || 'direct' }));
  }

  private readContextRecords(connectionId: string) {
    return readJson<Record<string, ContextRecord>>(this.contextPath(connectionId), {});
  }

  private readDingTalkReplyContexts(connectionId: string) {
    return readJson<Record<string, DingTalkReplyContextRecord>>(this.dingtalkReplyContextPath(connectionId), {});
  }

  private readInboundJobs(bindingId: string) {
    const value = readJson<unknown>(this.inboundJobPath(bindingId), []);
    if (!Array.isArray(value) || value.some((job) => !isInboundJob(job))) {
      throw new MessagingStoreCorruptionError(this.inboundJobPath(bindingId), 'expected an array of valid inbound jobs');
    }
    return value as InboundJob[];
  }

  private writeInboundJobs(bindingId: string, jobs: InboundJob[]) {
    writeJson(this.inboundJobPath(bindingId), jobs);
  }

  private updateInboundJob(bindingId: string, jobId: string, update: (job: InboundJob) => boolean) {
    const jobs = this.readInboundJobs(bindingId);
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job || !update(job)) return false;
    job.updated_at = new Date().toISOString();
    this.writeInboundJobs(bindingId, jobs);
    return true;
  }

  private listInboundJobBindingIds() {
    const path = this.inboundJobsPath();
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .filter((id) => SAFE_ID.test(id));
  }

  private readOutboundJobs() {
    const path = this.outboundJobsPath();
    if (!existsSync(path)) return [];
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ entry, value: readJson<unknown>(join(path, entry.name), null) }));
    if (entries.some(({ value }) => !isOutboundJob(value))) {
      const invalid = entries.find(({ value }) => !isOutboundJob(value))!;
      throw new MessagingStoreCorruptionError(join(path, invalid.entry.name), 'expected a valid outbound job');
    }
    return entries.map(({ value }) => value as OutboundJob);
  }

  private getOutboundJobById(id: string) {
    const value = readJson<unknown>(this.outboundJobPath(id), null);
    return isOutboundJob(value) ? value : null;
  }

  private findOutboundByCoalesceKey(bindingId: string, coalesceKey: string, state: OutboundJob['state']) {
    return this.readOutboundJobs().find((job) => job.binding_id === bindingId && job.coalesce_key === coalesceKey && job.state === state) || null;
  }

  private readInteractions() {
    const path = this.interactionsPath();
    if (!existsSync(path)) return [];
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ entry, value: readJson<unknown>(join(path, entry.name), null) }));
    if (entries.some(({ value }) => !isInteractionRecord(value))) {
      const invalid = entries.find(({ value }) => !isInteractionRecord(value))!;
      throw new MessagingStoreCorruptionError(join(path, invalid.entry.name), 'expected a valid interaction record');
    }
    return entries.map(({ value }) => value as InteractionRecord);
  }

  private readAdapterState(connectionId: string) {
    const value = readJson<unknown>(this.adapterStatePath(connectionId), {});
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new MessagingStoreCorruptionError(this.adapterStatePath(connectionId), 'expected a JSON object');
    }
    return value as Record<string, unknown>;
  }

  private requireConnection(id: string) {
    const record = this.getConnection(id);
    if (!record) throw new Error(`Messaging connection not found: ${id}`);
    return record;
  }

  private requireWeixinConnection(id: string) {
    const record = this.getWeixinConnection(id);
    if (!record) throw new Error(`Weixin connection not found: ${id}`);
    return record;
  }

  private requirePlatformConnection(id: string, platform: MessagingPlatform) {
    const record = this.getConnection(id);
    if (!record || record.platform !== platform) throw new Error(`Messaging connection not found: ${id}`);
    return record;
  }

  private readPlatformSecretRefs(record: MessagingConnectionRecord) {
    if (record.platform === 'dingtalk') {
      return Object.values(this.readDingTalkReplyContexts(record.id)).map((context) => context.secret_ref);
    }
    if (record.platform === 'feishu') return [];
    return Object.values(this.readContextRecords(record.id)).map((context) => context.secret_ref);
  }

  private writeSecret(id: string, value: string) {
    assertId(id);
    writeJson(this.secretPath(id), { value, updated_at: new Date().toISOString() });
  }

  private readSecret(id: string) {
    const secret = readJson<{ value?: string }>(this.secretPath(id), {});
    return typeof secret.value === 'string' && secret.value ? secret.value : undefined;
  }

  private connectionsIndexPath() { return join(this.connectionsPath, 'index.json'); }
  private connectionPath(id: string) { assertId(id); return join(this.connectionsPath, `${id}.json`); }
  private secretPath(id: string) { assertId(id); return join(this.secretsPath, `${id}.json`); }
  private weixinConnectionPath(id: string) { assertId(id); return join(this.weixinPath, id); }
  private dingtalkConnectionPath(id: string) { assertId(id); return join(this.dingtalkPath, id); }
  private feishuConnectionPath(id: string) { assertId(id); return join(this.feishuPath, id); }
  private platformConnectionPath(id: string, platform: MessagingPlatform) {
    if (platform === 'dingtalk') return this.dingtalkConnectionPath(id);
    if (platform === 'feishu') return this.feishuConnectionPath(id);
    return this.weixinConnectionPath(id);
  }
  private contextPath(id: string) { return join(this.weixinConnectionPath(id), 'context-tokens.json'); }
  private dingtalkReplyContextPath(id: string) { return join(this.dingtalkConnectionPath(id), 'reply-contexts.json'); }
  private inboundJobsPath() { return join(this.root, 'inbound-jobs'); }
  private outboundJobsPath() { return join(this.root, 'outbound-jobs'); }
  private interactionsPath() { return join(this.root, 'interactions'); }
  private adapterStatesPath() { return join(this.root, 'adapter-state'); }
  private inboundJobPath(bindingId: string) { assertId(bindingId); return join(this.inboundJobsPath(), `${bindingId}.json`); }
  private outboundJobPath(id: string) { assertId(id); return join(this.outboundJobsPath(), `${id}.json`); }
  private interactionPath(id: string) { assertId(id); return join(this.interactionsPath(), `${id}.json`); }
  private adapterStatePath(id: string) { assertId(id); return join(this.adapterStatesPath(), `${id}.json`); }
}

function toPublicConnection(record: WeixinConnectionRecord): PublicWeixinConnection;
function toPublicConnection(record: DingTalkConnectionRecord): PublicDingTalkConnection;
function toPublicConnection(record: FeishuConnectionRecord): PublicFeishuConnection;
function toPublicConnection(record: MessagingConnectionRecord): PublicMessagingConnection;
function toPublicConnection(record: MessagingConnectionRecord): PublicMessagingConnection {
  if (record.platform === 'dingtalk') {
    const { client_secret_ref: _secret, ...publicRecord } = record;
    return { ...publicRecord, name: publicRecord.name === '钉钉' ? 'DingTalk' : publicRecord.name };
  }
  if (record.platform === 'feishu') {
    const { app_secret_ref: _secret, ...publicRecord } = record;
    return { ...publicRecord, name: publicRecord.name === '飞书' ? 'Feishu' : publicRecord.name };
  }
  const { bot_token_secret_ref: _secret, ...publicRecord } = record;
  return { ...publicRecord, name: publicRecord.name === '微信' ? 'WeChat' : publicRecord.name };
}

function connectionSecretRef(record: MessagingConnectionRecord) {
  if (record.platform === 'dingtalk') return record.client_secret_ref;
  if (record.platform === 'feishu') return record.app_secret_ref;
  return record.bot_token_secret_ref;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new MessagingStoreCorruptionError(path, error instanceof Error ? error.message : String(error));
  }
}

export class MessagingStoreCorruptionError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`Messaging store JSON is corrupted at ${path}: ${detail}`);
    this.name = 'MessagingStoreCorruptionError';
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function assertId(value: string) {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid messaging id: ${value}`);
}

function normalizeStringList(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function isBinding(value: unknown): value is MessagingBinding {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MessagingBinding>;
  return typeof candidate.id === 'string'
    && (candidate.platform === undefined || candidate.platform === 'weixin' || candidate.platform === 'dingtalk' || candidate.platform === 'feishu')
    && typeof candidate.account_id === 'string'
    && typeof candidate.conversation_id === 'string'
    && (candidate.conversation_type === undefined || candidate.conversation_type === 'direct' || candidate.conversation_type === 'group' || candidate.conversation_type === 'channel')
    && typeof candidate.session_id === 'string';
}

function isWeixinConnection(value: unknown): value is WeixinConnectionRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WeixinConnectionRecord>;
  return candidate.platform === 'weixin'
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.enabled === 'boolean'
    && typeof candidate.ilink_bot_id === 'string'
    && typeof candidate.api_base_url === 'string'
    && typeof candidate.bot_token_secret_ref === 'string';
}

function isDingTalkConnection(value: unknown): value is DingTalkConnectionRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DingTalkConnectionRecord>;
  return candidate.platform === 'dingtalk'
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.enabled === 'boolean'
    && typeof candidate.client_id === 'string'
    && typeof candidate.client_secret_ref === 'string';
}

function isFeishuConnection(value: unknown): value is FeishuConnectionRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FeishuConnectionRecord>;
  return candidate.platform === 'feishu'
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.enabled === 'boolean'
    && typeof candidate.app_id === 'string'
    && typeof candidate.app_secret_ref === 'string'
    && (candidate.domain === 'feishu' || candidate.domain === 'lark');
}

function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImageAttachment>;
  return typeof candidate.id === 'string'
    && SAFE_ID.test(candidate.id)
    && candidate.kind === 'image'
    && typeof candidate.mime_type === 'string'
    && typeof candidate.relative_path === 'string'
    && typeof candidate.size === 'number'
    && candidate.size > 0
    && typeof candidate.sha256 === 'string'
    && SHA256.test(candidate.sha256);
}

function isInboundJob(value: unknown): value is InboundJob {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InboundJob>;
  return typeof candidate.id === 'string'
    && SAFE_ID.test(candidate.id)
    && typeof candidate.binding_id === 'string'
    && typeof candidate.platform_message_id === 'string'
    && typeof candidate.text === 'string'
    && (candidate.state === 'queued' || candidate.state === 'running' || candidate.state === 'delivering' || candidate.state === 'completed' || candidate.state === 'failed')
    && typeof candidate.created_at === 'string'
    && typeof candidate.updated_at === 'string';
}

function isOutboundJob(value: unknown): value is OutboundJob {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OutboundJob>;
  return typeof candidate.id === 'string'
    && SAFE_ID.test(candidate.id)
    && typeof candidate.idempotency_key === 'string'
    && typeof candidate.content_hash === 'string'
    && typeof candidate.binding_id === 'string'
    && typeof candidate.completes_inbound === 'boolean'
    && isStoredOutboundOperation(candidate.operation)
    && (candidate.state === 'pending' || candidate.state === 'sending' || candidate.state === 'delivered' || candidate.state === 'failed')
    && typeof candidate.attempt_count === 'number'
    && typeof candidate.next_attempt_at === 'string'
    && Array.isArray(candidate.receipts)
    && typeof candidate.created_at === 'string'
    && typeof candidate.updated_at === 'string';
}

function isStoredOutboundOperation(value: unknown): value is StoredOutboundOperation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredOutboundOperation>;
  if (candidate.kind === 'message') return Array.isArray(candidate.contents);
  if (candidate.kind === 'activity') return typeof candidate.active === 'boolean';
  if (candidate.kind === 'status') return candidate.phase === 'working' || candidate.phase === 'waiting_input' || candidate.phase === 'waiting_approval';
  if (candidate.kind === 'interaction') return typeof candidate.interaction_id === 'string' && Array.isArray(candidate.options);
  return candidate.kind === 'result' && typeof candidate.text === 'string';
}

function isInteractionRecord(value: unknown): value is InteractionRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InteractionRecord>;
  return typeof candidate.id === 'string'
    && SAFE_ID.test(candidate.id)
    && typeof candidate.run_id === 'string'
    && typeof candidate.binding_id === 'string'
    && typeof candidate.request_id === 'string'
    && (candidate.kind === 'ask' || candidate.kind === 'approval')
    && Array.isArray(candidate.choices)
    && (candidate.state === 'pending' || candidate.state === 'resolving' || candidate.state === 'resolved' || candidate.state === 'expired')
    && typeof candidate.created_at === 'string'
    && typeof candidate.updated_at === 'string';
}

function hashOutboundOperation(operation: StoredOutboundOperation) {
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}
