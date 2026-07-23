import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { MessagingConnectionState, MessagingDeliveryReceipt, MessagingOutboundRequest, MessagingPlatform } from '@moke/messaging-core';
import type { ImageAttachment } from '@moke/protocol';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEDUPE_RETRY_AFTER_MS = 5 * 60_000;

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

type Binding = {
  id: string;
  platform: MessagingPlatform;
  account_id: string;
  conversation_id: string;
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

type DedupeRecord = { state: 'processing' | 'completed'; updated_at: string };

export type QueuedInboundMessage = {
  message_id: string;
  content: string;
  attachments?: ImageAttachment[];
  created_at: string;
  run_id?: string;
};

type BindingQueue = {
  version: 1;
  active?: QueuedInboundMessage;
  pending: QueuedInboundMessage[];
};

export type OutboxRecord = {
  idempotency_key: string;
  binding_id: string;
  run_id?: string;
  state: 'processing' | 'completed' | 'failed';
  receipts: MessagingDeliveryReceipt[];
  error?: string;
  updated_at: string;
};

export class JsonMessagingStore {
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
    mkdirSync(this.outboxPath(), { recursive: true });
    if (!existsSync(this.connectionsIndexPath())) writeJson(this.connectionsIndexPath(), []);
    if (!existsSync(this.bindingsPath)) writeJson(this.bindingsPath, []);
  }

  listConnections() {
    return this.readConnectionIds()
      .map((id) => this.getConnection(id))
      .filter((record): record is MessagingConnectionRecord => !!record)
      .map(toPublicConnection);
  }

  getConnection(id: string) {
    assertId(id);
    const record = readJson<unknown>(this.connectionPath(id), null);
    return isWeixinConnection(record) || isDingTalkConnection(record) || isFeishuConnection(record) ? record : null;
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

  getDingTalkClientSecret(connection: DingTalkConnectionRecord) {
    return this.readSecret(connection.client_secret_ref);
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

  getFeishuAppSecret(connection: FeishuConnectionRecord) {
    return this.readSecret(connection.app_secret_ref);
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

  recordDingTalkStreamEvent(id: string, topic: string) {
    const record = this.getDingTalkConnection(id);
    if (!record) throw new Error('DingTalk connection not found');
    const now = new Date().toISOString();
    record.last_event_at = now;
    record.last_event_topic = topic.slice(0, 200);
    record.updated_at = now;
    writeJson(this.connectionPath(id), record);
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
      rmSync(this.queuePath(binding.id), { force: true });
    }
    rmSync(this.connectionPath(id), { force: true });
    rmSync(platformPath, { recursive: true, force: true });
    rmSync(this.secretPath(connectionSecretRef(record)), { force: true });
    writeJson(this.connectionsIndexPath(), this.readConnectionIds().filter((candidate) => candidate !== id));
    writeJson(this.bindingsPath, bindings.filter((binding) => binding.account_id !== id));
  }

  getToken(connection: WeixinConnectionRecord) {
    return this.readSecret(connection.bot_token_secret_ref);
  }

  getCursor(connectionId: string) {
    return readJson<{ cursor?: string }>(join(this.weixinConnectionPath(connectionId), 'sync.json'), {}).cursor || '';
  }

  saveCursor(connectionId: string, cursor: string) {
    writeJson(join(this.weixinConnectionPath(connectionId), 'sync.json'), { cursor, updated_at: new Date().toISOString() });
  }

  saveContextToken(input: { connectionId: string; peerUserId: string; token: string; messageId: string }) {
    const records = this.readContextRecords(input.connectionId);
    const secretRef = `ctx_${input.connectionId}_${shortHash(input.peerUserId)}`;
    this.writeSecret(secretRef, input.token);
    records[input.peerUserId] = {
      peer_user_id: input.peerUserId,
      secret_ref: secretRef,
      source_message_id: input.messageId,
      updated_at: new Date().toISOString(),
    };
    writeJson(this.contextPath(input.connectionId), records);
  }

  getContextToken(connectionId: string, peerUserId: string) {
    const record = this.readContextRecords(connectionId)[peerUserId];
    return record ? this.readSecret(record.secret_ref) : undefined;
  }

  saveDingTalkReplyContext(input: {
    connectionId: string;
    conversationId: string;
    sessionWebhook: string;
    sourceMessageId: string;
    expiresAt?: string;
  }) {
    const records = this.readDingTalkReplyContexts(input.connectionId);
    const secretRef = `ctx_${input.connectionId}_${shortHash(input.conversationId)}`;
    this.writeSecret(secretRef, input.sessionWebhook);
    records[input.conversationId] = {
      conversation_id: input.conversationId,
      secret_ref: secretRef,
      source_message_id: input.sourceMessageId,
      ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
      updated_at: new Date().toISOString(),
    };
    writeJson(this.dingtalkReplyContextPath(input.connectionId), records);
  }

  getDingTalkReplyContext(connectionId: string, conversationId: string) {
    const record = this.readDingTalkReplyContexts(connectionId)[conversationId];
    if (!record) return null;
    return {
      sessionWebhook: this.readSecret(record.secret_ref),
      sourceMessageId: record.source_message_id,
      ...(record.expires_at ? { expiresAt: record.expires_at } : {}),
    };
  }

  findBinding(connectionId: string, conversationId: string, platform: MessagingPlatform = 'weixin') {
    return this.readBindings().find((binding) =>
      binding.platform === platform && binding.account_id === connectionId && binding.conversation_id === conversationId) || null;
  }

  getBinding(bindingId: string) {
    return this.readBindings().find((binding) => binding.id === bindingId) || null;
  }

  createBinding(input: { connectionId: string; conversationId: string; sessionId: string; platform?: MessagingPlatform }) {
    const now = new Date().toISOString();
    const binding: Binding = {
      id: `bind_${randomUUID().slice(0, 8)}`,
      platform: input.platform || 'weixin',
      account_id: input.connectionId,
      conversation_id: input.conversationId,
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

  enqueueInbound(bindingId: string, input: Omit<QueuedInboundMessage, 'created_at' | 'run_id'>) {
    const queue = this.readQueue(bindingId);
    queue.pending.push({ ...input, created_at: new Date().toISOString() });
    this.writeQueue(bindingId, queue);
  }

  claimNextQueued(bindingId: string) {
    const queue = this.readQueue(bindingId);
    if (queue.active || queue.pending.length === 0) return null;
    const active = queue.pending.shift();
    if (!active) return null;
    queue.active = active;
    this.writeQueue(bindingId, queue);
    return active;
  }

  setQueuedRun(bindingId: string, messageId: string, runId: string) {
    const queue = this.readQueue(bindingId);
    if (!queue.active || queue.active.message_id !== messageId) return false;
    queue.active.run_id = runId;
    this.writeQueue(bindingId, queue);
    return true;
  }

  completeQueuedRun(bindingId: string, runId: string) {
    const queue = this.readQueue(bindingId);
    if (!queue.active || queue.active.run_id !== runId) return false;
    queue.active = undefined;
    this.writeQueue(bindingId, queue);
    return true;
  }

  discardQueuedMessage(bindingId: string, messageId: string) {
    const queue = this.readQueue(bindingId);
    if (!queue.active || queue.active.message_id !== messageId) return false;
    queue.active = undefined;
    this.writeQueue(bindingId, queue);
    return true;
  }

  recoverQueuedBindings() {
    const queuesPath = this.queuesPath();
    if (!existsSync(queuesPath)) return [];
    const bindingIds = readdirSync(queuesPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .filter((id) => SAFE_ID.test(id));
    for (const bindingId of bindingIds) {
      const queue = this.readQueue(bindingId);
      if (queue.active) {
        queue.pending.unshift({ ...queue.active, run_id: undefined });
        queue.active = undefined;
        this.writeQueue(bindingId, queue);
      }
    }
    return bindingIds.filter((bindingId) => {
      const queue = this.readQueue(bindingId);
      return !!queue.active || queue.pending.length > 0;
    });
  }

  claimInbound(connectionId: string, messageId: string, platform: MessagingPlatform = 'weixin') {
    const records = this.readDedupe(connectionId, platform);
    const existing = records[messageId];
    const updatedAt = existing ? Date.parse(existing.updated_at) : 0;
    if (existing?.state === 'completed') return 'duplicate' as const;
    if (existing?.state === 'processing' && Date.now() - updatedAt < DEDUPE_RETRY_AFTER_MS) return 'duplicate' as const;
    records[messageId] = { state: 'processing', updated_at: new Date().toISOString() };
    writeJson(this.dedupePath(connectionId, platform), records);
    return 'claimed' as const;
  }

  completeInbound(connectionId: string, messageId: string, platform: MessagingPlatform = 'weixin') {
    const records = this.readDedupe(connectionId, platform);
    records[messageId] = { state: 'completed', updated_at: new Date().toISOString() };
    writeJson(this.dedupePath(connectionId, platform), records);
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

  getOutbox(idempotencyKey: string) {
    return readJson<OutboxRecord | null>(this.outboxRecordPath(idempotencyKey), null);
  }

  beginOutbox(input: MessagingOutboundRequest) {
    const existing = this.getOutbox(input.idempotency_key);
    if (existing?.state === 'completed') return existing;
    const record: OutboxRecord = {
      idempotency_key: input.idempotency_key,
      binding_id: input.binding_id,
      ...(input.run_id ? { run_id: input.run_id } : {}),
      state: 'processing',
      receipts: existing?.receipts || [],
      updated_at: new Date().toISOString(),
    };
    writeJson(this.outboxRecordPath(input.idempotency_key), record);
    return record;
  }

  appendOutboxReceipt(idempotencyKey: string, receipt: MessagingDeliveryReceipt) {
    const record = this.getOutbox(idempotencyKey);
    if (!record) throw new Error(`Messaging outbox record is missing: ${idempotencyKey}`);
    record.receipts.push(receipt);
    record.updated_at = new Date().toISOString();
    writeJson(this.outboxRecordPath(idempotencyKey), record);
    return record;
  }

  finishOutbox(idempotencyKey: string) {
    const record = this.getOutbox(idempotencyKey);
    if (!record) throw new Error(`Messaging outbox record is missing: ${idempotencyKey}`);
    record.state = 'completed';
    record.error = undefined;
    record.updated_at = new Date().toISOString();
    writeJson(this.outboxRecordPath(idempotencyKey), record);
    return record;
  }

  failOutbox(idempotencyKey: string, error: string) {
    const record = this.getOutbox(idempotencyKey);
    if (!record) throw new Error(`Messaging outbox record is missing: ${idempotencyKey}`);
    record.state = 'failed';
    record.error = error.slice(0, 500);
    record.updated_at = new Date().toISOString();
    writeJson(this.outboxRecordPath(idempotencyKey), record);
    return record;
  }

  private readConnectionIds() {
    const ids = readJson<unknown>(this.connectionsIndexPath(), []);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && SAFE_ID.test(id)) : [];
  }

  private readBindings() {
    const bindings = readJson<unknown>(this.bindingsPath, []);
    return Array.isArray(bindings) ? bindings.filter(isBinding) : [];
  }

  private readContextRecords(connectionId: string) {
    return readJson<Record<string, ContextRecord>>(this.contextPath(connectionId), {});
  }

  private readDingTalkReplyContexts(connectionId: string) {
    return readJson<Record<string, DingTalkReplyContextRecord>>(this.dingtalkReplyContextPath(connectionId), {});
  }

  private readDedupe(connectionId: string, platform: MessagingPlatform) {
    return readJson<Record<string, DedupeRecord>>(this.dedupePath(connectionId, platform), {});
  }

  private readQueue(bindingId: string): BindingQueue {
    const queue = readJson<Partial<BindingQueue>>(this.queuePath(bindingId), {});
    return {
      version: 1,
      ...(isQueuedMessage(queue.active) ? { active: queue.active } : {}),
      pending: Array.isArray(queue.pending) ? queue.pending.filter(isQueuedMessage) : [],
    };
  }

  private writeQueue(bindingId: string, queue: BindingQueue) {
    writeJson(this.queuePath(bindingId), queue);
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
  private dedupePath(id: string, platform: MessagingPlatform) {
    return join(this.platformConnectionPath(id, platform), 'dedupe.json');
  }
  private queuesPath() { return join(this.root, 'queues'); }
  private outboxPath() { return join(this.root, 'outbox'); }
  private queuePath(bindingId: string) { assertId(bindingId); return join(this.queuesPath(), `${bindingId}.json`); }
  private outboxRecordPath(idempotencyKey: string) {
    return join(this.outboxPath(), `${createHash('sha256').update(idempotencyKey).digest('hex')}.json`);
  }
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
  } catch {
    return fallback;
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

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function normalizeStringList(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function isBinding(value: unknown): value is Binding {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Binding>;
  return typeof candidate.id === 'string'
    && (candidate.platform === undefined || candidate.platform === 'weixin' || candidate.platform === 'dingtalk' || candidate.platform === 'feishu')
    && typeof candidate.account_id === 'string'
    && typeof candidate.conversation_id === 'string'
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

function isQueuedMessage(value: unknown): value is QueuedInboundMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<QueuedInboundMessage>;
  return typeof candidate.message_id === 'string'
    && typeof candidate.content === 'string'
    && typeof candidate.created_at === 'string'
    && (candidate.attachments === undefined
      || (Array.isArray(candidate.attachments) && candidate.attachments.every(isImageAttachment)))
    && (candidate.run_id === undefined || typeof candidate.run_id === 'string');
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
