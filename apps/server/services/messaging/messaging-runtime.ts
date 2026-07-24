import type { RunManager, RuntimeRun } from '@moke/agent-runtime';
import { MessagingDeliveryError } from '@moke/messaging-core';
import type {
  AgentEvent,
  PendingApproval,
  PendingAsk,
  ResolvedImageAttachment,
} from '@moke/protocol';
import type {
  InboundAck,
  InteractionAck,
  MessagingDeliveryContent,
  MessagingAdapterEvent,
  MessagingInteractionAction,
  MessagingInboundEvent,
  MessagingOutboundOperation,
  MessagingOutboundRequest,
  MessagingOutboundResult,
  OutboundContent,
} from '@moke/messaging-core';

import { AttachmentStore, toStoredAttachment } from '../../storage/attachment-store.js';
import {
  MessagingStore,
  type InboundJob,
  type InteractionRecord,
  type PublicMessagingConnection,
  type PublicWeixinConnection,
  type StoredOutboundOperation,
} from '../../storage/messaging-store.js';
import { SessionApplicationService } from '../session-application-service.js';
import { readMessagingDeliveryContents, validateMessagingMediaPaths } from './outbound-media.js';
import { MessagingConnectionPool } from './connection-pool.js';

const MAX_OUTBOUND_ATTEMPTS = 8;

/**
 * The single messaging application entry point. It owns FIFO progression and
 * durable side-effect scheduling; adapters only translate platform protocol.
 */
export class MessagingRuntime {
  private readonly drainingBindings = new Set<string>();
  private outboxDrain: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly store: MessagingStore,
    private readonly connections: MessagingConnectionPool,
    private readonly sessions: SessionApplicationService,
    private readonly runManager: RunManager,
    private readonly attachments: AttachmentStore,
    private readonly workspace: string,
    private readonly approvedRoots: () => string[],
  ) {
    connections.setEventHandler((event) => this.accept(event));
  }

  async start() {
    this.store.recoverInboundJobs();
    this.store.recoverOutboundJobs();
    await this.connections.startEnabled();
    for (const bindingId of this.store.listRecoverableInboundBindings()) await this.drainBinding(bindingId);
    await this.drainOutbox();
  }

  async close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.outboxDrain;
    await this.connections.close();
  }

  async accept(event: MessagingAdapterEvent): Promise<InboundAck | InteractionAck> {
    if (event.type === 'interaction') return this.handleCardAction(event.action);
    return this.acceptInbound(event.message);
  }

  async acceptInbound(event: MessagingInboundEvent): Promise<InboundAck> {
    let binding = this.store.findBinding(event.account_id, event.conversation.id, event.platform);
    if (!binding) {
      const session = this.sessions.createSession({
        title: conversationTitle(event.platform),
        metadata: { messaging: { platform: event.platform, connection_id: event.account_id } },
      });
      binding = this.store.createBinding({
        connectionId: event.account_id,
        conversationId: event.conversation.id,
        conversationType: event.conversation.type,
        sessionId: session.id,
        platform: event.platform,
      });
    }
    const text = event.message.segments
      .filter((segment): segment is Extract<typeof segment, { type: 'text' }> => segment.type === 'text')
      .map((segment) => segment.text)
      .filter(Boolean)
      .join('\n')
      .trim();
    const attachments = await this.storeInboundImages(event);
    if (!text && attachments.length === 0) return { status: 'ignored' };

    const queued = this.store.enqueueInboundJob({
      bindingId: binding.id,
      platformMessageId: event.message.id,
      text,
      ...(attachments.length ? { attachments: attachments.map(toStoredAttachment) } : {}),
    });
    if (queued.status === 'duplicate') return { status: 'duplicate' };
    this.store.markBindingInbound(binding.id, event.message.id, event.sender.id);
    this.store.recordInbound(event.account_id, event.platform);
    await this.drainBinding(binding.id);
    return { status: 'accepted' };
  }

  onRunEvent(event: AgentEvent, run: RuntimeRun) {
    if (run.origin.kind !== 'messaging') return;
    const bindingId = run.origin.binding_id;
    if (event.type === 'agent.started') {
      this.enqueueRunOperation(run, {
        kind: 'activity', active: true,
      }, `run:${run.id}:activity:start`);
      this.enqueueRunOperation(run, {
        kind: 'status', phase: 'working', title: 'Working', detail: 'Thinking about your request.',
      }, `run:${run.id}:status:started`, `run:${run.id}:status`);
      return;
    }
    if (event.type === 'tool.call') {
      this.enqueueRunOperation(run, {
        kind: 'status', phase: 'working', title: 'Working', detail: `Using ${event.payload.tool}`,
      }, `run:${run.id}:status:${event.seq}`, `run:${run.id}:status`);
      return;
    }
    if (event.type === 'ask_user.required') {
      this.enqueueRunOperation(run, { kind: 'activity', active: false }, `run:${run.id}:activity:waiting-ask`);
      this.enqueueRunOperation(run, {
        kind: 'status', phase: 'waiting_input', title: 'Waiting for input', detail: event.payload.question,
      }, `run:${run.id}:status:${event.seq}`, `run:${run.id}:status`);
      const interaction = this.store.createInteraction({
        run_id: run.id,
        binding_id: bindingId,
        request_id: event.payload.ask_id,
        kind: 'ask',
        allowed_sender_id: this.store.getBinding(bindingId)?.last_sender_id,
        choices: event.payload.options.map((option) => ({ id: option.id, label: option.label, value: { option_id: option.id } })),
      });
      this.enqueueInteraction(run, interaction, event.payload.question);
      return;
    }
    if (event.type === 'approval.required') {
      this.enqueueRunOperation(run, { kind: 'activity', active: false }, `run:${run.id}:activity:waiting-approval`);
      this.enqueueRunOperation(run, {
        kind: 'status', phase: 'waiting_approval', title: 'Waiting for approval', detail: event.payload.reason,
      }, `run:${run.id}:status:${event.seq}`, `run:${run.id}:status`);
      const interaction = this.store.createInteraction({
        run_id: run.id,
        binding_id: bindingId,
        request_id: event.payload.approval_id,
        kind: 'approval',
        allowed_sender_id: this.store.getBinding(bindingId)?.last_sender_id,
        choices: approvalChoices(),
      });
      this.enqueueInteraction(run, interaction, approvalDetail(event.payload));
      return;
    }
    if (event.type === 'ask_user.answered') {
      const interaction = this.store.findInteraction(run.id, event.payload.ask_id);
      if (interaction) this.enqueueResolvedInteraction(run, interaction, `Selected: ${event.payload.selected.label}`);
      this.enqueueRunOperation(run, { kind: 'activity', active: true }, `run:${run.id}:activity:resume-ask`);
      return;
    }
    if (event.type === 'approval.resolved') {
      const interaction = this.store.findInteraction(run.id, event.payload.approval_id);
      if (interaction) {
        const label = event.payload.decision === 'approved' ? `Allowed for ${event.payload.scope}` : 'Rejected';
        this.enqueueResolvedInteraction(run, interaction, label);
      }
      this.enqueueRunOperation(run, { kind: 'activity', active: true }, `run:${run.id}:activity:resume-approval`);
      return;
    }
    if (event.type === 'agent.done' || event.type === 'agent.error') {
      void this.finishRun(event, run);
    }
  }

  async send(input: MessagingOutboundRequest): Promise<MessagingOutboundResult> {
    await this.validateMediaPaths(input.contents);
    const job = this.store.enqueueOutboundJob({
      idempotencyKey: input.idempotency_key,
      bindingId: input.binding_id,
      operation: { kind: 'message', contents: input.contents },
    });
    await this.drainOutbox();
    const completed = await this.waitForOutbound(input.idempotency_key);
    if (completed.state !== 'delivered') throw new Error(completed.error || 'Messaging delivery failed');
    return { receipts: completed.receipts };
  }

  async validateMediaPaths(contents: OutboundContent[]) {
    await validateMessagingMediaPaths(this.workspace, this.approvedRoots, contents);
  }

  listConnections() {
    return this.store.listConnections();
  }

  getConnection(connectionId: string) {
    return this.store.getPublicConnection(connectionId);
  }

  async createConnection(input:
    | { platform: 'dingtalk'; credentials: { name?: string; clientId: string; clientSecret: string; allowedUserIds?: string[]; cardTemplateId?: string } }
    | { platform: 'feishu'; credentials: { name?: string; appId: string; appSecret: string; domain?: 'feishu' | 'lark' } },
  ): Promise<PublicMessagingConnection | null> {
    const connection = input.platform === 'dingtalk'
      ? this.store.createDingTalkConnection(input.credentials)
      : this.store.createFeishuConnection(input.credentials);
    try {
      await this.startConnection(connection.id);
    } catch (error) {
      this.store.updateConnectionState(connection.id, {
        state: 'error',
        error: { code: 'MESSAGING_CONNECTION_START_FAILED', message: errorMessage(error) },
      });
    }
    return this.store.getPublicConnection(connection.id);
  }

  async completeWeixinLogin(input: {
    connectionId?: string;
    name: string;
    ilinkBotId: string;
    userId?: string;
    apiBaseUrl: string;
    token: string;
  }): Promise<PublicWeixinConnection> {
    const record = input.connectionId
      ? this.store.replaceConnectionAuth(input.connectionId, {
          ilinkBotId: input.ilinkBotId,
          userId: input.userId,
          apiBaseUrl: input.apiBaseUrl,
          token: input.token,
        })
      : this.store.createConnection({
          name: input.name,
          ilinkBotId: input.ilinkBotId,
          userId: input.userId,
          apiBaseUrl: input.apiBaseUrl,
          token: input.token,
        });
    try {
      const connection = await this.startConnection(record.id);
      if (!connection || connection.platform !== 'weixin') {
        throw new Error('WeChat connection was not created');
      }
      return connection;
    } catch (error) {
      this.store.updateConnectionState(record.id, {
        state: 'error',
        error: { code: 'MESSAGING_CONNECTION_START_FAILED', message: errorMessage(error) },
      });
      throw error;
    }
  }

  async updateConnection(input: { id: string; enabled?: boolean; allowedUserIds?: string[]; cardTemplateId?: string }) {
    const current = this.store.getConnection(input.id);
    if (!current) return null;
    if ((input.allowedUserIds !== undefined || input.cardTemplateId !== undefined) && current.platform !== 'dingtalk') {
      throw new Error('These settings are only available for DingTalk');
    }
    if (current.platform === 'dingtalk' && (input.allowedUserIds !== undefined || input.cardTemplateId !== undefined)) {
      this.store.updateDingTalkOptions(input.id, input);
      if (current.enabled) {
        await this.stopConnection(input.id);
        await this.startConnection(input.id);
      }
    }
    if (input.enabled !== undefined) {
      this.store.setConnectionEnabled(input.id, input.enabled);
      if (input.enabled) await this.startConnection(input.id);
      else await this.stopConnection(input.id);
    }
    return this.store.getPublicConnection(input.id);
  }

  startConnection(connectionId: string) {
    return this.connections.start(connectionId);
  }

  stopConnection(connectionId: string, reason: 'user' | 'shutdown' | 'reauth' = 'user') {
    return this.connections.stop(connectionId, reason);
  }

  removeConnection(connectionId: string) {
    return this.connections.remove(connectionId);
  }

  private async drainBinding(bindingId: string) {
    if (this.drainingBindings.has(bindingId) || this.closed) return;
    this.drainingBindings.add(bindingId);
    let job: InboundJob | null = null;
    try {
      job = this.store.claimNextInboundJob(bindingId);
      if (!job) return;
      const claimedJob = job;
      const binding = this.store.getBinding(bindingId);
      const session = binding && this.sessions.getSession(binding.session_id);
      if (!binding || !session) {
        this.store.failInboundJob(bindingId, job.id, 'Messaging binding session is missing');
        queueMicrotask(() => void this.drainBinding(bindingId));
        return;
      }
      let attachments: ResolvedImageAttachment[];
      try {
        attachments = job.attachments?.map((attachment) => this.attachments.resolve(attachment)) || [];
      } catch (error) {
        this.store.failInboundJob(bindingId, job.id, errorMessage(error));
        queueMicrotask(() => void this.drainBinding(bindingId));
        return;
      }
      this.sessions.acceptUserMessage({
        session,
        content: claimedJob.text,
        attachments,
        source: {
          kind: 'messaging',
          platform: binding.platform,
          connection_id: binding.account_id,
          message_id: claimedJob.platform_message_id,
        },
        options: {
          origin: {
            kind: 'messaging',
            platform: binding.platform,
            connection_id: binding.account_id,
            binding_id: binding.id,
            inbound_message_id: claimedJob.platform_message_id,
          },
          beforeStart: (run) => {
            if (!this.store.setInboundRun(bindingId, claimedJob.id, run.id)) {
              throw new Error(`Messaging inbound job was lost before run start: ${claimedJob.id}`);
            }
          },
        },
      });
    } catch (error) {
      if (job) this.store.failInboundJob(bindingId, job.id, errorMessage(error));
      console.warn(`[messaging] failed to start inbound binding=${bindingId}: ${errorMessage(error)}`);
      queueMicrotask(() => void this.drainBinding(bindingId));
    } finally {
      this.drainingBindings.delete(bindingId);
    }
  }

  private async finishRun(event: Extract<AgentEvent, { type: 'agent.done' | 'agent.error' }>, run: RuntimeRun) {
    const bindingId = run.origin.kind === 'messaging' ? run.origin.binding_id : undefined;
    if (!bindingId) return;
    const inbound = this.store.findInboundJobByRun(run.id);
    if (!inbound) return;
    if (event.type === 'agent.done' && event.payload.status === 'cancelled' && run.cancel_reason === 'shutdown') return;
    this.store.markInboundDelivering(bindingId, inbound.id);
    this.store.expireRunInteractions(run.id);
    this.enqueueRunOperation(run, { kind: 'activity', active: false }, `run:${run.id}:activity:stop`);
    const completed = event.type === 'agent.done' && event.payload.status === 'completed';
    const text = completed ? this.finalText(bindingId) : event.type === 'agent.error' ? `Task failed: ${event.payload.message}` : 'The task was cancelled.';
    this.store.enqueueOutboundJob({
      idempotencyKey: `run:${run.id}:result`,
      bindingId,
      inboundJobId: inbound.id,
      completesInbound: true,
      coalesceKey: `run:${run.id}:status`,
      operation: {
        kind: 'result',
        outcome: completed ? 'completed' : event.type === 'agent.error' ? 'failed' : 'cancelled',
        text,
        message_already_delivered: this.store.hasDeliveredText(bindingId, text, run.id),
      },
    });
    await this.drainOutbox();
  }

  private enqueueRunOperation(run: RuntimeRun, operation: StoredOutboundOperation, idempotencyKey: string, coalesceKey?: string) {
    if (run.origin.kind !== 'messaging') return;
    this.store.enqueueOutboundJob({
      idempotencyKey,
      bindingId: run.origin.binding_id,
      operation,
      ...(coalesceKey ? { coalesceKey } : {}),
    });
    void this.drainOutbox();
  }

  private enqueueInteraction(run: RuntimeRun, interaction: InteractionRecord, detail: string) {
    this.enqueueRunOperation(run, {
      kind: 'interaction',
      interaction_id: interaction.id,
      title: interaction.kind === 'ask' ? 'Input required' : 'Approval required',
      detail,
      options: interaction.choices.map((choice) => ({ id: choice.id, label: choice.label })),
    }, `interaction:${interaction.id}:pending`, `interaction:${interaction.id}`);
  }

  private enqueueResolvedInteraction(run: RuntimeRun, interaction: InteractionRecord, label: string) {
    if (interaction.state === 'pending' || interaction.state === 'resolving') {
      this.store.resolveInteraction(interaction.id, { label });
    }
    this.enqueueRunOperation(run, {
      kind: 'interaction',
      interaction_id: interaction.id,
      title: interaction.kind === 'ask' ? 'Response received' : 'Approval resolved',
      detail: interaction.kind === 'ask' ? 'Input received.' : 'Approval request completed.',
      options: [],
      resolved: { label },
    }, `interaction:${interaction.id}:resolved`, `interaction:${interaction.id}`);
  }

  private handleCardAction(action: MessagingInteractionAction): InteractionAck {
    const interactionId = action.interaction_id;
    const optionId = action.option_id;
    if (!interactionId || !optionId) return interactionAck('invalid', 'This request is no longer available');
    const interaction = this.store.claimInteraction(interactionId);
    if (!interaction) return interactionAck('already_resolved', 'This request is no longer pending');
    const binding = this.store.getBinding(interaction.binding_id);
    if (!binding || binding.account_id !== action.account_id
      || (action.conversation_id && binding.conversation_id !== action.conversation_id)
      || (interaction.allowed_sender_id && action.sender_id !== interaction.allowed_sender_id)) {
      this.store.releaseInteraction(interaction.id);
      return interactionAck('rejected', 'Only the person who started this task can respond');
    }
    const choice = interaction.choices.find((candidate) => candidate.id === optionId);
    if (!choice) {
      this.store.releaseInteraction(interaction.id);
      return interactionAck('invalid', 'This response is invalid');
    }
    const result = interaction.kind === 'ask'
      ? this.runManager.answer(interaction.run_id, interaction.request_id, choice.value.option_id || choice.id)
      : this.runManager.approve(
          interaction.run_id,
          interaction.request_id,
          choice.value.decision === 'rejected' ? 'rejected' : 'approved',
          { scope: choice.value.scope === 'once' || choice.value.scope === 'persistent' ? choice.value.scope : 'session' },
        );
    if (result.status !== 200) {
      this.store.releaseInteraction(interaction.id);
      return interactionAck('already_resolved', result.error || 'This request is no longer pending');
    }
    return interactionAck('accepted', 'Response received');
  }

  private async drainOutbox() {
    if (this.outboxDrain) return this.outboxDrain;
    this.outboxDrain = this.runOutbox().finally(() => { this.outboxDrain = undefined; });
    return this.outboxDrain;
  }

  private async runOutbox() {
    const jobs = this.store.claimDueOutboundJobs(20);
    for (const job of jobs) {
      let result: Awaited<ReturnType<MessagingConnectionPool['deliver']>>;
      try {
        const binding = this.store.getBinding(job.binding_id);
        if (!binding) throw new MessagingDeliveryError('TARGET_NOT_FOUND', 'Messaging binding is missing', false);
        const operation = await this.materializeOperation(job.operation);
        const reference = job.coalesce_key ? this.store.getLatestOutboundReference(job.binding_id, job.coalesce_key) : undefined;
        result = await this.connections.deliver(binding, operation, reference);
      } catch (error) {
        const classified = classifyDeliveryError(error);
        const message = `${classified.code}: ${classified.message}`;
        if (!classified.retryable || job.attempt_count + 1 >= MAX_OUTBOUND_ATTEMPTS) {
          try {
            const failed = this.store.failOutboundJob(job.id, message);
            if (failed.releasedBindingId) void this.drainBinding(failed.releasedBindingId);
          } catch (persistenceError) {
            console.error(`[messaging] failed to persist permanent delivery failure job=${job.id}: ${errorMessage(persistenceError)}`);
            this.store.recoverInboundJobs();
          }
        } else {
          try {
            this.store.retryOutboundJob(job.id, message, new Date(Date.now() + retryDelay(job.attempt_count)).toISOString());
          } catch (persistenceError) {
            console.error(`[messaging] failed to persist delivery retry job=${job.id}: ${errorMessage(persistenceError)}`);
            this.store.recoverInboundJobs();
          }
        }
        continue;
      }
      try {
        const completed = this.store.completeOutboundJob(job.id, result);
        if (completed.releasedBindingId) void this.drainBinding(completed.releasedBindingId);
      } catch (persistenceError) {
        // The platform call already succeeded. Recovery reconciles the terminal
        // Outbox record with its InboundJob instead of sending the message again.
        console.error(`[messaging] failed to persist delivered outbound job=${job.id}: ${errorMessage(persistenceError)}`);
        this.store.recoverInboundJobs();
      }
    }
    if (!this.closed) this.scheduleRetry();
  }

  private async materializeOperation(operation: StoredOutboundOperation): Promise<MessagingOutboundOperation> {
    if (operation.kind !== 'message') return operation;
    const contents: MessagingDeliveryContent[] = await readMessagingDeliveryContents(this.workspace, this.approvedRoots, operation.contents);
    return { ...operation, contents };
  }

  private async waitForOutbound(idempotencyKey: string) {
    for (;;) {
      const job = this.store.getOutboundJob(idempotencyKey);
      if (!job) throw new Error('Messaging outbound job is missing');
      if (job.state === 'delivered' || job.state === 'failed') return job;
      await wait(50);
      await this.drainOutbox();
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const nextAttemptAt = this.store.getNextOutboundAttemptAt();
    if (!nextAttemptAt) return;
    const nextAttemptTime = Date.parse(nextAttemptAt);
    const delay = Number.isFinite(nextAttemptTime)
      ? Math.max(0, Math.min(nextAttemptTime - Date.now(), 2_147_483_647))
      : 0;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.drainOutbox();
    }, delay);
  }

  private async storeInboundImages(event: MessagingInboundEvent) {
    const images = event.message.segments
      .filter((segment): segment is Extract<typeof segment, { type: 'image' }> => segment.type === 'image' && !!segment.data)
      .slice(0, 4);
    let totalBytes = 0;
    const saved = await Promise.all(images.map(async (segment, index) => {
      try {
        const data = Buffer.from(segment.data!);
        totalBytes += data.length;
        if (totalBytes > 5 * 1024 * 1024) throw new Error('Messaging image attachments are too large');
        return this.attachments.saveInboundImage(data, segment.name || `${event.platform}-${event.message.id}-${index + 1}`);
      } catch (error) {
        console.warn(`[messaging] discarded inbound image message=${event.message.id}: ${errorMessage(error)}`);
        return null;
      }
    }));
    return saved.filter((attachment): attachment is ResolvedImageAttachment => attachment !== null);
  }

  private finalText(bindingId: string) {
    const binding = this.store.getBinding(bindingId);
    const session = binding && this.sessions.getSession(binding.session_id);
    const message = session && [...session.messages].reverse().find((candidate) => candidate.role === 'assistant' && candidate.content.trim());
    return message?.content || 'The task completed without a text result.';
  }
}

function conversationTitle(platform: MessagingInboundEvent['platform']) {
  return platform === 'weixin' ? 'WeChat contact' : platform === 'dingtalk' ? 'DingTalk conversation' : 'Feishu conversation';
}

function approvalChoices() {
  return [
    { id: 'approve_once', label: 'Allow once', value: { decision: 'approved', scope: 'once' } },
    { id: 'approve_session', label: 'Allow for session', value: { decision: 'approved', scope: 'session' } },
    { id: 'reject', label: 'Reject', value: { decision: 'rejected', scope: 'once' } },
  ];
}

function approvalDetail(approval: PendingApproval) {
  return `${approval.reason}\n\nTool: ${approval.action.tool}\nRisk: ${approval.risk}`;
}

function retryDelay(attempt: number) {
  return [1_000, 5_000, 30_000, 120_000, 600_000][Math.min(attempt, 4)] + Math.floor(Math.random() * 250);
}

function classifyDeliveryError(error: unknown) {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string' && typeof candidate.retryable === 'boolean') {
      return { code: candidate.code, message: candidate.message, retryable: candidate.retryable };
    }
  }
  const message = errorMessage(error);
  const code = message.match(/^([A-Z][A-Z0-9_]+):\s*/)?.[1];
  if (code === 'UNSUPPORTED_CAPABILITY' || code === 'CONVERSATION_CONTEXT_EXPIRED' || code === 'CONTEXT_UNAVAILABLE' || code === 'TARGET_NOT_FOUND') {
    return { code, message: message.slice(code.length + 1).trim(), retryable: false };
  }
  return { code: 'MESSAGING_DELIVERY_FAILED', message, retryable: true };
}

function interactionAck(status: InteractionAck['status'], message: string): InteractionAck {
  return { status, message };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wait(delay: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delay));
}
