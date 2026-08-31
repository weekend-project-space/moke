import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { InboundJob, MessagingConnectionRecord } from './messaging-store-types.js';
import { isImageAttachment, readJson, SAFE_ID, writeJson } from './messaging-store-files.js';
import { MessagingOutboundStore } from './messaging-outbound.js';

export class MessagingStorePersistence extends MessagingOutboundStore {
  initialize() {
    this.initializeDirectories();
    this.validateReadableStore();
    this.migrateLegacyQueues();
    this.migrateAdapterState();
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
            state[`dingtalk.reply:${conversation}`] = { sessionWebhook: webhook, ...(record.expires_at ? { expiresAt: record.expires_at } : {}) };
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
}
