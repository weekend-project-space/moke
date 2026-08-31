import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { MessagingPlatform } from '@moke/messaging-core';
import type { ImageAttachment } from '@moke/protocol';
import type {
  ContextRecord,
  DingTalkReplyContextRecord,
  InboundJob,
  InteractionRecord,
  MessagingBinding,
  MessagingConnectionRecord,
  OutboundJob,
  StoredOutboundOperation,
} from './messaging-store-types.js';

export const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class MessagingStoreCorruptionError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`Messaging store JSON is corrupted at ${path}: ${detail}`);
    this.name = 'MessagingStoreCorruptionError';
  }
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new MessagingStoreCorruptionError(path, error instanceof Error ? error.message : String(error));
  }
}

export function writeJson(path: string, value: unknown) {
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

export function assertId(value: string) {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid messaging id: ${value}`);
}

export function normalizeStringList(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

export function isBinding(value: unknown): value is MessagingBinding {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MessagingBinding>;
  return typeof candidate.id === 'string'
    && (candidate.platform === undefined || candidate.platform === 'weixin' || candidate.platform === 'dingtalk' || candidate.platform === 'feishu')
    && typeof candidate.account_id === 'string'
    && typeof candidate.conversation_id === 'string'
    && (candidate.conversation_type === undefined || candidate.conversation_type === 'direct' || candidate.conversation_type === 'group' || candidate.conversation_type === 'channel')
    && typeof candidate.session_id === 'string';
}

export function isWeixinConnection(value: unknown): value is Extract<MessagingConnectionRecord, { platform: 'weixin' }> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Extract<MessagingConnectionRecord, { platform: 'weixin' }>>;
  return candidate.platform === 'weixin' && typeof candidate.id === 'string' && typeof candidate.name === 'string'
    && typeof candidate.enabled === 'boolean' && typeof candidate.ilink_bot_id === 'string'
    && typeof candidate.api_base_url === 'string' && typeof candidate.bot_token_secret_ref === 'string';
}

export function isDingTalkConnection(value: unknown): value is Extract<MessagingConnectionRecord, { platform: 'dingtalk' }> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Extract<MessagingConnectionRecord, { platform: 'dingtalk' }>>;
  return candidate.platform === 'dingtalk' && typeof candidate.id === 'string' && typeof candidate.name === 'string'
    && typeof candidate.enabled === 'boolean' && typeof candidate.client_id === 'string' && typeof candidate.client_secret_ref === 'string';
}

export function isFeishuConnection(value: unknown): value is Extract<MessagingConnectionRecord, { platform: 'feishu' }> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Extract<MessagingConnectionRecord, { platform: 'feishu' }>>;
  return candidate.platform === 'feishu' && typeof candidate.id === 'string' && typeof candidate.name === 'string'
    && typeof candidate.enabled === 'boolean' && typeof candidate.app_id === 'string'
    && typeof candidate.app_secret_ref === 'string' && (candidate.domain === 'feishu' || candidate.domain === 'lark');
}

export function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImageAttachment>;
  return typeof candidate.id === 'string' && SAFE_ID.test(candidate.id) && candidate.kind === 'image'
    && typeof candidate.mime_type === 'string' && typeof candidate.relative_path === 'string'
    && typeof candidate.size === 'number' && candidate.size > 0 && typeof candidate.sha256 === 'string' && SHA256.test(candidate.sha256);
}

export function isInboundJob(value: unknown): value is InboundJob {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InboundJob>;
  return typeof candidate.id === 'string' && SAFE_ID.test(candidate.id) && typeof candidate.binding_id === 'string'
    && typeof candidate.platform_message_id === 'string' && typeof candidate.text === 'string'
    && (candidate.state === 'queued' || candidate.state === 'running' || candidate.state === 'delivering' || candidate.state === 'completed' || candidate.state === 'failed')
    && typeof candidate.created_at === 'string' && typeof candidate.updated_at === 'string';
}

export function isStoredOutboundOperation(value: unknown): value is StoredOutboundOperation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredOutboundOperation>;
  if (candidate.kind === 'message') {
    return Array.isArray(candidate.contents)
      && (candidate.workspace_root === undefined || typeof candidate.workspace_root === 'string')
      && (candidate.approved_roots === undefined || (Array.isArray(candidate.approved_roots) && candidate.approved_roots.every((root) => typeof root === 'string')));
  }
  if (candidate.kind === 'activity') return typeof candidate.active === 'boolean';
  if (candidate.kind === 'status') return candidate.phase === 'working' || candidate.phase === 'waiting_input' || candidate.phase === 'waiting_approval';
  if (candidate.kind === 'interaction') return typeof candidate.interaction_id === 'string'
    && (candidate.interaction_kind === undefined || candidate.interaction_kind === 'ask' || candidate.interaction_kind === 'approval') && Array.isArray(candidate.options);
  return candidate.kind === 'result' && typeof candidate.text === 'string';
}

export function isOutboundJob(value: unknown): value is OutboundJob {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OutboundJob>;
  return typeof candidate.id === 'string' && SAFE_ID.test(candidate.id) && typeof candidate.idempotency_key === 'string'
    && typeof candidate.content_hash === 'string' && typeof candidate.binding_id === 'string' && typeof candidate.completes_inbound === 'boolean'
    && isStoredOutboundOperation(candidate.operation) && (candidate.state === 'pending' || candidate.state === 'sending' || candidate.state === 'delivered' || candidate.state === 'failed')
    && typeof candidate.attempt_count === 'number' && typeof candidate.next_attempt_at === 'string' && Array.isArray(candidate.receipts)
    && typeof candidate.created_at === 'string' && typeof candidate.updated_at === 'string';
}

export function isInteractionRecord(value: unknown): value is InteractionRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InteractionRecord>;
  return typeof candidate.id === 'string' && SAFE_ID.test(candidate.id) && typeof candidate.run_id === 'string'
    && typeof candidate.binding_id === 'string' && typeof candidate.request_id === 'string'
    && (candidate.kind === 'ask' || candidate.kind === 'approval') && Array.isArray(candidate.choices)
    && (candidate.state === 'pending' || candidate.state === 'resolving' || candidate.state === 'resolved' || candidate.state === 'expired')
    && typeof candidate.created_at === 'string' && typeof candidate.updated_at === 'string';
}

export function hashOutboundOperation(operation: StoredOutboundOperation) {
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}

export class MessagingStoreFiles {
  protected readonly root: string;
  protected readonly connectionsPath: string;
  protected readonly bindingsPath: string;
  protected readonly secretsPath: string;
  protected readonly weixinPath: string;
  protected readonly dingtalkPath: string;
  protected readonly feishuPath: string;

  constructor(storePath: string) {
    this.root = join(storePath, 'messaging');
    this.connectionsPath = join(this.root, 'connections');
    this.bindingsPath = join(this.root, 'bindings', 'index.json');
    this.secretsPath = join(this.root, 'secrets');
    this.weixinPath = join(this.root, 'weixin');
    this.dingtalkPath = join(this.root, 'dingtalk');
    this.feishuPath = join(this.root, 'feishu');
  }

  protected initializeDirectories() {
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
  }

  protected readConnectionIds() {
    const ids = readJson<unknown>(this.connectionsIndexPath(), []);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !SAFE_ID.test(id))) {
      throw new MessagingStoreCorruptionError(this.connectionsIndexPath(), 'expected an array of safe connection ids');
    }
    return ids as string[];
  }

  protected readBindings() {
    const bindings = readJson<unknown>(this.bindingsPath, []);
    if (!Array.isArray(bindings) || bindings.some((binding) => !isBinding(binding))) {
      throw new MessagingStoreCorruptionError(this.bindingsPath, 'expected an array of valid bindings');
    }
    return bindings.map((binding) => ({ ...binding, conversation_type: binding.conversation_type || 'direct' }));
  }

  protected readContextRecords(connectionId: string) {
    return readJson<Record<string, ContextRecord>>(this.contextPath(connectionId), {});
  }

  protected readDingTalkReplyContexts(connectionId: string) {
    return readJson<Record<string, DingTalkReplyContextRecord>>(this.dingtalkReplyContextPath(connectionId), {});
  }

  protected readInboundJobs(bindingId: string) {
    const path = this.inboundJobPath(bindingId);
    const value = readJson<unknown>(path, []);
    if (!Array.isArray(value) || value.some((job) => !isInboundJob(job))) {
      throw new MessagingStoreCorruptionError(path, 'expected an array of valid inbound jobs');
    }
    return value as InboundJob[];
  }

  protected writeInboundJobs(bindingId: string, jobs: InboundJob[]) { writeJson(this.inboundJobPath(bindingId), jobs); }

  protected updateInboundJob(bindingId: string, jobId: string, update: (job: InboundJob) => boolean) {
    const jobs = this.readInboundJobs(bindingId);
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job || !update(job)) return false;
    job.updated_at = new Date().toISOString();
    this.writeInboundJobs(bindingId, jobs);
    return true;
  }

  protected listInboundJobBindingIds() {
    const path = this.inboundJobsPath();
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length)).filter((id) => SAFE_ID.test(id));
  }

  protected readOutboundJobs() {
    const path = this.outboundJobsPath();
    if (!existsSync(path)) return [];
    const entries = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ entry, value: readJson<unknown>(join(path, entry.name), null) }));
    const invalid = entries.find(({ value }) => !isOutboundJob(value));
    if (invalid) throw new MessagingStoreCorruptionError(join(path, invalid.entry.name), 'expected a valid outbound job');
    return entries.map(({ value }) => value as OutboundJob);
  }

  protected getOutboundJobById(id: string) {
    const value = readJson<unknown>(this.outboundJobPath(id), null);
    return isOutboundJob(value) ? value : null;
  }

  protected findOutboundByCoalesceKey(bindingId: string, coalesceKey: string, state: OutboundJob['state']) {
    return this.readOutboundJobs().find((job) => job.binding_id === bindingId && job.coalesce_key === coalesceKey && job.state === state) || null;
  }

  protected readInteractions() {
    const path = this.interactionsPath();
    if (!existsSync(path)) return [];
    const entries = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ entry, value: readJson<unknown>(join(path, entry.name), null) }));
    const invalid = entries.find(({ value }) => !isInteractionRecord(value));
    if (invalid) throw new MessagingStoreCorruptionError(join(path, invalid.entry.name), 'expected a valid interaction record');
    return entries.map(({ value }) => value as InteractionRecord);
  }

  protected readAdapterState(connectionId: string) {
    const path = this.adapterStatePath(connectionId);
    const value = readJson<unknown>(path, {});
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MessagingStoreCorruptionError(path, 'expected a JSON object');
    return value as Record<string, unknown>;
  }

  protected writeSecret(id: string, value: string) { assertId(id); writeJson(this.secretPath(id), { value, updated_at: new Date().toISOString() }); }
  protected readSecret(id: string) {
    const secret = readJson<{ value?: string }>(this.secretPath(id), {});
    return typeof secret.value === 'string' && secret.value ? secret.value : undefined;
  }

  protected connectionsIndexPath() { return join(this.connectionsPath, 'index.json'); }
  protected connectionPath(id: string) { assertId(id); return join(this.connectionsPath, `${id}.json`); }
  protected secretPath(id: string) { assertId(id); return join(this.secretsPath, `${id}.json`); }
  protected weixinConnectionPath(id: string) { assertId(id); return join(this.weixinPath, id); }
  protected dingtalkConnectionPath(id: string) { assertId(id); return join(this.dingtalkPath, id); }
  protected feishuConnectionPath(id: string) { assertId(id); return join(this.feishuPath, id); }
  protected platformConnectionPath(id: string, platform: MessagingPlatform) {
    if (platform === 'dingtalk') return this.dingtalkConnectionPath(id);
    if (platform === 'feishu') return this.feishuConnectionPath(id);
    return this.weixinConnectionPath(id);
  }
  protected contextPath(id: string) { return join(this.weixinConnectionPath(id), 'context-tokens.json'); }
  protected dingtalkReplyContextPath(id: string) { return join(this.dingtalkConnectionPath(id), 'reply-contexts.json'); }
  protected inboundJobsPath() { return join(this.root, 'inbound-jobs'); }
  protected outboundJobsPath() { return join(this.root, 'outbound-jobs'); }
  protected interactionsPath() { return join(this.root, 'interactions'); }
  protected adapterStatesPath() { return join(this.root, 'adapter-state'); }
  protected inboundJobPath(bindingId: string) { assertId(bindingId); return join(this.inboundJobsPath(), `${bindingId}.json`); }
  protected outboundJobPath(id: string) { assertId(id); return join(this.outboundJobsPath(), `${id}.json`); }
  protected interactionPath(id: string) { assertId(id); return join(this.interactionsPath(), `${id}.json`); }
  protected adapterStatePath(id: string) { assertId(id); return join(this.adapterStatesPath(), `${id}.json`); }
}
