import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';

import type { MessagingConnectionState, MessagingPlatform } from '@moke/messaging-core';
import type {
  DingTalkConnectionRecord,
  FeishuConnectionRecord,
  MessagingConnectionRecord,
  PublicDingTalkConnection,
  PublicFeishuConnection,
  PublicMessagingConnection,
  PublicWeixinConnection,
  WeixinConnectionRecord,
} from './messaging-store-types.js';
import {
  assertId,
  isDingTalkConnection,
  isFeishuConnection,
  isWeixinConnection,
  MessagingStoreCorruptionError,
  normalizeStringList,
  readJson,
  writeJson,
  MessagingStoreFiles,
} from './messaging-store-files.js';

export class MessagingConnectionsStore extends MessagingStoreFiles {
  listConnections(): PublicMessagingConnection[] {
    return this.readConnectionIds().map((id) => this.getConnection(id)).filter((record): record is MessagingConnectionRecord => !!record).map(toPublicConnection);
  }

  getConnection(id: string): MessagingConnectionRecord | null {
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

  createConnection(input: { name: string; ilinkBotId: string; userId?: string; apiBaseUrl: string; token: string }) {
    const now = new Date().toISOString();
    const id = `wxconn_${randomUUID().slice(0, 8)}`;
    const secretRef = `secret_${id}`;
    const record: WeixinConnectionRecord = {
      id, platform: 'weixin', name: input.name.trim() || 'WeChat', enabled: true,
      ilink_bot_id: input.ilinkBotId, ...(input.userId ? { user_id: input.userId } : {}), api_base_url: input.apiBaseUrl,
      bot_token_secret_ref: secretRef, state: 'stopped', created_at: now, updated_at: now,
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
      id, platform: 'dingtalk', name: input.name?.trim() || 'DingTalk', enabled: true, client_id: clientId,
      client_secret_ref: secretRef, ...(input.allowedUserIds?.length ? { allowed_user_ids: normalizeStringList(input.allowedUserIds) } : {}),
      ...(input.cardTemplateId?.trim() ? { card_template_id: input.cardTemplateId.trim() } : {}), state: 'stopped', created_at: now, updated_at: now,
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

  createFeishuConnection(input: { name?: string; appId: string; appSecret: string; domain?: 'feishu' | 'lark' }) {
    const appId = input.appId.trim();
    const appSecret = input.appSecret.trim();
    if (!appId || !appSecret) throw new Error('Feishu app id and app secret are required');
    const now = new Date().toISOString();
    const id = `fsconn_${randomUUID().slice(0, 8)}`;
    const secretRef = `secret_${id}`;
    const record: FeishuConnectionRecord = {
      id, platform: 'feishu', name: input.name?.trim() || 'Feishu', enabled: true, app_id: appId, app_secret_ref: secretRef,
      domain: input.domain === 'lark' ? 'lark' : 'feishu', state: 'stopped', created_at: now, updated_at: now,
    };
    this.writeSecret(secretRef, appSecret);
    writeJson(this.connectionPath(id), record);
    writeJson(this.connectionsIndexPath(), [...this.readConnectionIds(), id]);
    return toPublicConnection(record);
  }

  getConnectionSecret(connection: MessagingConnectionRecord) { return this.getSecret(connectionSecretRef(connection)); }
  getSecret(ref: string) { return this.readSecret(ref); }

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

  updateConnectionState(id: string, input: { state: MessagingConnectionState; error?: { code: string; message: string } }) {
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
    for (const secretRef of this.readPlatformSecretRefs(record)) rmSync(this.secretPath(secretRef), { force: true });
    for (const binding of removedBindings) {
      rmSync(this.inboundJobPath(binding.id), { force: true });
      for (const outbound of this.readOutboundJobs().filter((job) => job.binding_id === binding.id)) rmSync(this.outboundJobPath(outbound.id), { force: true });
      for (const interaction of this.readInteractions().filter((item) => item.binding_id === binding.id)) rmSync(this.interactionPath(interaction.id), { force: true });
    }
    rmSync(this.connectionPath(id), { force: true });
    rmSync(this.platformConnectionPath(id, record.platform), { recursive: true, force: true });
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

  protected requireConnection(id: string) {
    const record = this.getConnection(id);
    if (!record) throw new Error(`Messaging connection not found: ${id}`);
    return record;
  }

  protected requireWeixinConnection(id: string) {
    const record = this.getWeixinConnection(id);
    if (!record) throw new Error(`Weixin connection not found: ${id}`);
    return record;
  }

  protected requirePlatformConnection(id: string, platform: MessagingPlatform) {
    const record = this.getConnection(id);
    if (!record || record.platform !== platform) throw new Error(`Messaging connection not found: ${id}`);
    return record;
  }

  protected readPlatformSecretRefs(record: MessagingConnectionRecord) {
    if (record.platform === 'dingtalk') return Object.values(this.readDingTalkReplyContexts(record.id)).map((context) => context.secret_ref);
    if (record.platform === 'feishu') return [];
    return Object.values(this.readContextRecords(record.id)).map((context) => context.secret_ref);
  }
}

export function toPublicConnection(record: WeixinConnectionRecord): PublicWeixinConnection;
export function toPublicConnection(record: DingTalkConnectionRecord): PublicDingTalkConnection;
export function toPublicConnection(record: FeishuConnectionRecord): PublicFeishuConnection;
export function toPublicConnection(record: MessagingConnectionRecord): PublicMessagingConnection;
export function toPublicConnection(record: MessagingConnectionRecord): PublicMessagingConnection {
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
