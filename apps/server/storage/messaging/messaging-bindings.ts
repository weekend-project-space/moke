import { randomUUID } from 'node:crypto';

import type { MessagingPlatform } from '@moke/messaging-core';
import type { ImageAttachment } from '@moke/protocol';
import type { InboundJob, MessagingBinding } from './messaging-store-types.js';
import { MessagingConnectionsStore } from './messaging-connections.js';
import { writeJson } from './messaging-store-files.js';

export class MessagingBindingsStore extends MessagingConnectionsStore {
  findBinding(connectionId: string, conversationId: string, platform: MessagingPlatform = 'weixin') {
    return this.readBindings().find((binding) => binding.platform === platform && binding.account_id === connectionId && binding.conversation_id === conversationId) || null;
  }

  getBinding(bindingId: string) {
    return this.readBindings().find((binding) => binding.id === bindingId) || null;
  }

  listBindings(input: { platform?: MessagingPlatform } = {}) {
    return this.readBindings().filter((binding) => !input.platform || binding.platform === input.platform);
  }

  createBinding(input: { connectionId: string; conversationId: string; conversationType?: 'direct' | 'group' | 'channel'; sessionId: string; platform?: MessagingPlatform }) {
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

  enqueueInboundJob(input: { bindingId: string; platformMessageId: string; text: string; attachments?: ImageAttachment[] }) {
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
      if (job.state !== 'queued' && job.state !== 'running' && job.state !== 'delivering') return false;
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
}
