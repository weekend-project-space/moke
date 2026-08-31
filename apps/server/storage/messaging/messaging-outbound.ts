import { randomUUID } from 'node:crypto';

import type { MessagingDeliveryResult } from '@moke/messaging-core';
import type { EnqueueOutboundInput, InteractionRecord, OutboundJob } from './messaging-store-types.js';
import { hashOutboundOperation, isInteractionRecord, readJson, writeJson } from './messaging-store-files.js';
import { MessagingBindingsStore } from './messaging-bindings.js';

export class MessagingOutboundStore extends MessagingBindingsStore {
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
    const jobs = this.readOutboundJobs().filter((job) => job.binding_id === bindingId && job.coalesce_key === coalesceKey && job.reference)
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
    const due = this.readOutboundJobs().filter((job) => job.state === 'pending' && job.next_attempt_at <= now)
      .sort((left, right) => left.next_attempt_at.localeCompare(right.next_attempt_at)).slice(0, Math.max(0, limit));
    for (const job of due) {
      job.state = 'sending';
      job.updated_at = new Date().toISOString();
      writeJson(this.outboundJobPath(job.id), job);
    }
    return due;
  }

  getNextOutboundAttemptAt() {
    return this.readOutboundJobs().filter((job) => job.state === 'pending')
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
    const record: InteractionRecord = { id: `int_${randomUUID().slice(0, 12)}`, ...input, state: 'pending', created_at: now, updated_at: now };
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

  findPendingInteraction(bindingId: string, kind: InteractionRecord['kind']) {
    return this.readInteractions().find((record) => record.binding_id === bindingId && record.kind === kind && record.state === 'pending') || null;
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

}
