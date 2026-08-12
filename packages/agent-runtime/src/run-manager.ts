import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentEventPayloadMap,
  FileAttachment,
  ImageAttachment,
  Message,
  PendingApproval,
  ResolvedImageAttachment,
  RunLifecycleEvent,
  RunStatus,
  Session,
  SessionEnvironment,
  ToolApprovalRecord,
} from '@moke/protocol';
import type { Agent } from './agent.js';
import { EventBus } from './event-bus.js';
import { resolveHistory, selectRecentHistory } from './history.js';
import { RunObservers } from './run-observers.js';
import type { RunOrigin, RuntimeRun } from './run-state.js';
import type {
  RuntimeContentManager,
  ToolApprovalDecision,
  ToolApprovalRequest,
  WorkspacePathApprovalDecision,
  WorkspacePathApprovalRequest,
} from './tool-context.js';
import type { AiApprovalReviewer, ApprovalReviewContext } from './approval-reviewer.js';
import type { ToolRegistry } from './tool-registry.js';

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

type RunManagerConfig = {
  runs: Map<string, RuntimeRun>;
  agent: Agent;
  toolRegistry: ToolRegistry;
  defaultWorkspaceRoot?: string;
  /** @deprecated Use defaultWorkspaceRoot. */
  workspace?: string;
  createSkillContentManager?: (workspace: string) => RuntimeContentManager | Promise<RuntimeContentManager>;
  resolveToolRegistry?: (workspace: string) => ToolRegistry | Promise<ToolRegistry>;
  approveWorkspaceRoot?: (root: string, scope: 'once' | 'session' | 'persistent', sessionId: string) => WorkspacePathApprovalDecision | void;
  workspaceRoots?: (sessionId: string) => string[];
  resolveImageAttachments?: (
    attachments: ImageAttachment[],
  ) => ResolvedImageAttachment[] | Promise<ResolvedImageAttachment[]>;
  onSessionChanged?: (session: Session) => void;
  aiApprovalReviewer?: AiApprovalReviewer;
};

export type RunOptions = {
  max_steps?: number;
  max_tool_calls?: number;
  timeout_ms?: number;
  origin?: RunOrigin;
  /**
   * Called after the run is registered but before agent execution starts.
   * Adapters use this to atomically associate external queue state with the run.
   */
  beforeStart?: (run: RuntimeRun) => void;
};

type RunMessageInput = {
  content: string;
  attachments?: ResolvedImageAttachment[];
  files?: FileAttachment[];
};

const MAX_RETAINED_TERMINAL_RUNS = 50;
const DEFAULT_RUN_TIMEOUT_MS = 72 * 60 * 60 * 1_000;

export { selectRecentHistory } from './history.js';

export class SessionRunActiveError extends Error {
  readonly code = 'SESSION_RUN_ACTIVE';

  constructor(
    readonly sessionId: string,
    readonly runId: string,
  ) {
    super(`Session ${sessionId} already has an active run: ${runId}`);
    this.name = 'SessionRunActiveError';
  }
}

function readSessionMessage(event: AgentEvent & { payload: AgentEventPayloadMap['agent.message.done'] }) {
  const message = event.payload.message;
  if (!message || typeof message !== 'object') return null;

  const candidate = message as Partial<Message>;
  if (
    (candidate.role !== 'user' && candidate.role !== 'assistant' && candidate.role !== 'tool') ||
    typeof candidate.content !== 'string' ||
    typeof candidate.created_at !== 'string'
  ) {
    return null;
  }

  if (event.step && candidate.role === 'assistant') {
    return {
      ...candidate,
      step: event.step,
    } as Message;
  }

  return candidate as Message;
}

export class RunManager {
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private readonly pendingAsks = new Map<
    string,
    {
      runId: string;
      resolve: (selected: { id: string; label: string }) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly pendingApprovals = new Map<
    string,
    {
      runId: string;
      resolve: (decision: WorkspacePathApprovalDecision | ToolApprovalDecision) => void;
      reject: (error: Error) => void;
      reviewer?: 'user' | 'ai' | 'auto_approve';
      reviewReason?: string;
    }
  >();
  private readonly approvalRecords = new Map<string, Map<string, ToolApprovalRecord[]>>();
  private readonly observers = new RunObservers();

  constructor(private readonly config: RunManagerConfig) { }

  getActiveRunForSession(sessionId: string) {
    return [...this.config.runs.values()].find(
      (run) => run.session_id === sessionId && isActiveRun(run),
    );
  }

  createRun(session: Session, input: RunMessageInput, options: RunOptions = {}) {
    if (this.shuttingDown) throw new Error('Run manager is shutting down');
    const activeRun = this.getActiveRunForSession(session.id);
    if (activeRun) throw new SessionRunActiveError(session.id, activeRun.id);
    const env = snapshotEnvironment(session.env, this.defaultWorkspaceRoot());
    const run: RuntimeRun = {
      id: id('run'),
      session_id: session.id,
      status: 'running',
      seq: 0,
      events: [],
      clients: new Set(),
      started_at: Date.now(),
      abort: false,
      origin: options.origin || { kind: 'local' },
      approval_mode: env.approval_mode,
      env,
    };

    this.config.runs.set(run.id, run);
    try {
      options.beforeStart?.(run);
    } catch (error) {
      this.config.runs.delete(run.id);
      throw error;
    }
    this.observers.notifyInitial(run);
    const execution = this.execute(run, session, input, options);
    this.activeExecutions.set(run.id, execution);
    void execution.then(
      () => this.activeExecutions.delete(run.id),
      () => this.activeExecutions.delete(run.id),
    );
    return run;
  }

  private async execute(run: RuntimeRun, session: Session, input: RunMessageInput, options: RunOptions) {
    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    const eventBus = new EventBus(run, (event) => {
      this.observers.notify(event, run);
      if (run.abort) return;
      if (event.type !== 'agent.message.done') {
        return;
      }

      const message = readSessionMessage(event);
      if (!message) return;

      session.messages.push(message);
      session.updated_at = message.created_at;
      this.config.onSessionChanged?.(session);
    });
    const limits = {
      max_steps: options.max_steps || 999,
      max_tool_calls: options.max_tool_calls || 99,
    };
    const runTimeoutMs = normalizeRunTimeout(options.timeout_ms);
    const timeout = setTimeout(
      () => this.timeoutRun(run, eventBus, runTimeoutMs),
      runTimeoutMs,
    );
    timeout.unref();

    try {
      const history = await resolveHistory(
        selectRecentHistory(session.messages.slice(0, -1)),
        this.config.resolveImageAttachments,
      );
      const sessionFiles = session.messages.flatMap((message) => message.role === 'user' ? (message.files || []) : []);
      const attachedFiles = [...new Map([...sessionFiles, ...(input.files || [])].map((file) => [file.path, file])).values()];
      const contentManager = await this.config.createSkillContentManager?.(run.env.workspace.root);
      const toolRegistry = await this.config.resolveToolRegistry?.(run.env.workspace.root)
        || this.config.toolRegistry;
      const result = await this.config.agent.run({
        input: input.content,
        attachments: input.attachments,
        history,
        eventBus,
        toolRegistry,
        context: {
          workspace: run.env.workspace.root,
          workspaceRoots: () => [
            ...(this.config.workspaceRoots?.(session.id) || []),
            ...attachedFiles.map((file) => file.path),
          ],
          run,
          abortSignal: abortController.signal,
          contentManager,
          trustedContext: [
            {
              authority: 'trusted',
              scope: 'run',
              content: `<session_environment>${JSON.stringify(run.env)}</session_environment>`,
            },
            ...(attachedFiles.length ? [{
              authority: 'trusted' as const,
              scope: 'run' as const,
              content: '<attached_files>\n' + attachedFileContext(attachedFiles) + '\n</attached_files>',
            }] : []),
          ],
          askUser: (input) => this.askUser(run, eventBus, input),
          approveWorkspacePath: (input) => this.approveWorkspacePath(run, eventBus, input),
          approveTool: (toolInput) => this.reviewTool(run, eventBus, toolInput, {
            approvalMode: run.approval_mode,
            environment: run.env,
            runId: run.id,
            sessionId: session.id,
            origin: run.origin,
            userRequest: input.content,
            signal: abortController.signal,
          }),
          consumeApprovals: (callId) => this.consumeApprovalRecords(run.id, callId),
        },
        limits,
      });

      if (run.abort) return;

      if (!session.messages.some((message) => message.id === result.message.id)) {
        session.messages.push(result.message);
        session.updated_at = result.message.created_at;
        this.config.onSessionChanged?.(session);
      }
      this.setStatus(run, 'completed');
      eventBus.emit('agent.done', {
        status: 'completed',
        usage: {
          steps: run.seq,
          tool_calls: result.toolCalls,
          duration_ms: Date.now() - run.started_at,
          ...result.usage,
        },
      });
    } catch (error) {
      if (run.abort) return;

      const message = error instanceof Error ? error.message : 'Unknown runtime error';
      console.error(`Run ${run.id} failed`, error);
      const assistantMessage: Message = {
        id: id('msg'),
        role: 'assistant',
        content: `Run failed: ${message}`,
        created_at: new Date().toISOString(),
      };
      this.setStatus(run, 'failed');
      eventBus.emit('agent.message.done', {
        message: assistantMessage,
      });
      eventBus.emit('agent.error', {
        code: 'RUNTIME_ERROR',
        message,
      });
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(run.id);
      this.approvalRecords.delete(run.id);
      this.pruneTerminalRuns();
    }
  }

  private approveWorkspacePath(
    run: RuntimeRun,
    eventBus: EventBus,
    input: WorkspacePathApprovalRequest,
  ): Promise<WorkspacePathApprovalDecision> {
    const approvalId = id('apv');
    const pendingApproval: PendingApproval = {
      approval_id: approvalId,
      ...(input.callId ? { call_id: input.callId } : {}),
      kind: 'workspace_path',
      reason: input.reason || `Allow access to ${input.suggestedRoot}?`,
      action: {
        tool: input.tool,
        input: safeApprovalInput(input.input),
      },
      path: input.path,
      suggested_root: input.suggestedRoot,
      created_at: new Date().toISOString(),
    };
    run.pending_approval = pendingApproval;
    this.setStatus(run, 'awaiting_approval');

    return new Promise<WorkspacePathApprovalDecision>((resolve, reject) => {
      this.pendingApprovals.set(approvalId, {
        runId: run.id,
        resolve,
        reject,
      });
      eventBus.emit('approval.required', pendingApproval);
    });
  }

  private defaultWorkspaceRoot() {
    return this.config.defaultWorkspaceRoot || this.config.workspace || process.cwd();
  }

  private async reviewTool(
    run: RuntimeRun,
    eventBus: EventBus,
    input: ToolApprovalRequest,
    context: ApprovalReviewContext,
  ): Promise<ToolApprovalDecision> {
    const approvalId = id('apv');
    if (context.approvalMode === 'auto_approve') {
      this.recordToolApproval(run.id, input.callId, {
        approvalId,
        decision: 'approved',
        reviewer: 'auto_approve',
        reviewReason: 'Approved by the session auto-approve policy',
        reason: input.reason,
      });
      return { approved: true, scope: 'once', reviewer: 'auto_approve', reviewReason: 'Approved by the session auto-approve policy' };
    }

    if (context.approvalMode === 'ai_review' && this.config.aiApprovalReviewer) {
      try {
        const review = await this.config.aiApprovalReviewer.review({
          approvalId,
          runId: context.runId,
          sessionId: context.sessionId,
          userRequest: context.userRequest,
          environment: context.environment,
          origin: context.origin,
          tool: input.tool,
          source: input.source,
          input: input.input,
        }, { signal: context.signal });
        if (review.decision !== 'escalated') {
          this.recordToolApproval(run.id, input.callId, {
            approvalId,
            decision: review.decision,
            reviewer: 'ai',
            reviewReason: review.reason,
            reason: input.reason,
          });
          return {
            approved: review.decision === 'approved',
            scope: 'once',
            reviewer: 'ai',
            reviewReason: review.reason,
            ...(review.decision === 'rejected' ? { message: review.reason } : {}),
          };
        }
        return this.requestUserToolApproval(run, eventBus, input, approvalId, 'ai', review.reason);
      } catch (error) {
        if (context.signal?.aborted) throw error;
        return this.requestUserToolApproval(run, eventBus, input, approvalId, 'ai', 'AI review unavailable; escalated to the user');
      }
    }

    return this.requestUserToolApproval(run, eventBus, input, approvalId, 'user');
  }

  private requestUserToolApproval(
    run: RuntimeRun,
    eventBus: EventBus,
    input: ToolApprovalRequest,
    approvalId = id('apv'),
    reviewer: 'user' | 'ai' = 'user',
    reviewReason?: string,
  ): Promise<ToolApprovalDecision> {
    const pendingApproval: PendingApproval = {
      approval_id: approvalId,
      ...(input.callId ? { call_id: input.callId } : {}),
      kind: 'tool',
      reason: input.reason,
      action: {
        tool: input.tool,
        input: safeApprovalInput(input.input),
      },
      created_at: new Date().toISOString(),
    };
    run.pending_approval = pendingApproval;
    this.setStatus(run, 'awaiting_approval');

    return new Promise<ToolApprovalDecision>((resolve, reject) => {
      this.pendingApprovals.set(approvalId, {
        runId: run.id,
        resolve,
        reject,
        reviewer,
        reviewReason,
      });
      eventBus.emit('approval.required', pendingApproval);
    });
  }

  private askUser(
    run: RuntimeRun,
    eventBus: EventBus,
    input: { callId: string; question: string; options: Array<{ id: string; label: string }> },
  ): Promise<{ id: string; label: string }> {
    const askId = id('ask');
    run.pending_ask = {
      ask_id: askId,
      call_id: input.callId,
      question: input.question,
      options: input.options,
      created_at: new Date().toISOString(),
    };
    this.setStatus(run, 'awaiting_user');

    return new Promise<{ id: string; label: string }>((resolve, reject) => {
      this.pendingAsks.set(askId, {
        runId: run.id,
        resolve,
        reject,
      });
      eventBus.emit('ask_user.required', run.pending_ask!);
    });
  }

  answer(runId: string, askId: string, optionId?: string, customText?: string) {
    const run = this.config.runs.get(runId);
    if (!run) return { status: 404 as const, error: 'Run not found' };
    if (run.pending_ask?.ask_id !== askId) return { status: 409 as const, error: 'Run is not waiting for this answer' };

    const pending = this.pendingAsks.get(askId);
    if (!pending || pending.runId !== runId) return { status: 409 as const, error: 'Ask is no longer pending' };
    const normalizedCustomText = customText?.trim();
    const selected = normalizedCustomText
      ? { id: 'custom', label: normalizedCustomText }
      : run.pending_ask.options.find((option) => option.id === optionId);
    if (!selected) return { status: 400 as const, error: 'option_id is not valid for this question' };

    this.pendingAsks.delete(askId);
    const pendingAsk = run.pending_ask;
    run.pending_ask = undefined;
    this.setStatus(run, 'running');

    const event = new EventBus(run).emit('ask_user.answered', {
      ask_id: pendingAsk.ask_id,
      call_id: pendingAsk.call_id,
      selected,
    });
    this.observers.notify(event, run);

    pending.resolve(selected);

    return { status: 200 as const, run };
  }

  approve(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
    options: { scope?: 'once' | 'session' | 'persistent'; message?: string } = {},
  ) {
    const run = this.config.runs.get(runId);
    if (!run) return { status: 404 as const, error: 'Run not found' };
    if (run.pending_approval?.approval_id !== approvalId) {
      return { status: 409 as const, error: 'Run is not waiting for this approval' };
    }

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.runId !== runId) return { status: 409 as const, error: 'Approval is no longer pending' };

    const pendingApproval = run.pending_approval;
    this.pendingApprovals.delete(approvalId);
    run.pending_approval = undefined;
    this.setStatus(run, 'running');
    const scope = pendingApproval.kind === 'tool' ? 'once' : (options.scope || 'session');
    this.recordApproval(run.id, pendingApproval, decision, scope, pending.reviewer || 'user', pending.reviewReason);
    const event = new EventBus(run).emit('approval.resolved', {
      approval_id: pendingApproval.approval_id,
      decision,
      scope,
    });
    this.observers.notify(event, run);
    const workspaceApproval =
      decision === 'approved' && pendingApproval.kind === 'workspace_path' && pendingApproval.suggested_root
        ? this.config.approveWorkspaceRoot?.(pendingApproval.suggested_root, scope, run.session_id)
        : undefined;

    pending.resolve({
      approved: decision === 'approved',
      scope,
      message: options.message,
      reviewer: pending.reviewer || 'user',
      reviewReason: pending.reviewReason,
      approvedRoots: workspaceApproval?.approvedRoots,
      cleanup: workspaceApproval?.cleanup,
    });

    return { status: 200 as const, run };
  }

  cancel(runId: string, reason: 'user' | 'shutdown' = 'user') {
    const run = this.config.runs.get(runId);
    if (!run || !isActiveRun(run)) return run || null;
    run.abort = true;
    run.cancel_reason = reason;
    this.setStatus(run, 'cancelled');
    this.abortControllers.get(runId)?.abort();
    this.abortControllers.delete(runId);
    this.rejectPendingInteractions(run, 'Run cancelled');

    const event = new EventBus(run).emit('agent.done', {
      status: 'cancelled',
      usage: {
        steps: run.seq,
        tool_calls: 0,
        duration_ms: Date.now() - run.started_at,
      },
    });
    this.observers.notify(event, run);
    this.pruneTerminalRuns();

    return run;
  }

  private timeoutRun(run: RuntimeRun, eventBus: EventBus, timeoutMs: number) {
    if (!isActiveRun(run)) return;

    eventBus.emit('agent.message.done', {
      message: {
        id: id('msg'),
        role: 'assistant',
        content: `Run timed out after ${timeoutMs}ms`,
        created_at: new Date().toISOString(),
      },
    });
    run.abort = true;
    this.setStatus(run, 'timeout');
    this.abortControllers.get(run.id)?.abort(new Error('Run timed out'));
    this.abortControllers.delete(run.id);
    this.rejectPendingInteractions(run, 'Run timed out');
    eventBus.emit('agent.done', {
      status: 'timeout',
      usage: {
        steps: run.seq,
        tool_calls: 0,
        duration_ms: Date.now() - run.started_at,
      },
    });
    this.pruneTerminalRuns();
  }

  private rejectPendingInteractions(run: RuntimeRun, message: string) {
    if (run.pending_ask) {
      const pending = this.pendingAsks.get(run.pending_ask.ask_id);
      this.pendingAsks.delete(run.pending_ask.ask_id);
      run.pending_ask = undefined;
      pending?.reject(new Error(message));
    }

    if (run.pending_approval) {
      const pending = this.pendingApprovals.get(run.pending_approval.approval_id);
      this.pendingApprovals.delete(run.pending_approval.approval_id);
      run.pending_approval = undefined;
      pending?.reject(new Error(message));
    }
  }

  addObserver(observer: (event: AgentEvent, run: RuntimeRun) => void) {
    return this.observers.addEventObserver(observer);
  }

  addLifecycleObserver(observer: (event: RunLifecycleEvent) => void) {
    return this.observers.addLifecycleObserver(observer);
  }

  private setStatus(run: RuntimeRun, status: RunStatus) {
    this.observers.notifyStatus(run, status);
  }

  cancelAll(reason: 'user' | 'shutdown' = 'user') {
    for (const run of this.config.runs.values()) {
      if (!isActiveRun(run)) continue;
      this.cancel(run.id, reason);
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    this.cancelAll('shutdown');
    await Promise.allSettled([...this.activeExecutions.values()]);
  }

  private pruneTerminalRuns() {
    const terminalRuns = [...this.config.runs.values()]
      .filter((run) => run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'timeout')
      .sort((left, right) => right.started_at - left.started_at);

    for (const run of terminalRuns.slice(MAX_RETAINED_TERMINAL_RUNS)) {
      this.config.runs.delete(run.id);
    }
  }

  private recordApproval(
    runId: string,
    approval: PendingApproval,
    decision: 'approved' | 'rejected',
    scope: 'once' | 'session' | 'persistent',
    reviewer: 'user' | 'ai' | 'auto_approve' = 'user',
    reviewReason?: string,
  ) {
    if (!approval.call_id) return;

    let runRecords = this.approvalRecords.get(runId);
    if (!runRecords) {
      runRecords = new Map();
      this.approvalRecords.set(runId, runRecords);
    }
    const records = runRecords.get(approval.call_id) || [];
    records.push({
      approval_id: approval.approval_id,
      kind: approval.kind,
      decision,
      scope,
      reason: approval.reason,
      reviewer,
      ...(reviewReason ? { review_reason: reviewReason } : {}),
      ...(reviewer === 'auto_approve' ? { approval_mode: 'auto_approve' as const } : {}),
    });
    runRecords.set(approval.call_id, records);
  }

  private recordToolApproval(
    runId: string,
    callId: string | undefined,
    input: {
      approvalId: string;
      decision: 'approved' | 'rejected';
      reviewer: 'ai' | 'auto_approve';
      reviewReason: string;
      reason: string;
    },
  ) {
    if (!callId) return;
    let runRecords = this.approvalRecords.get(runId);
    if (!runRecords) {
      runRecords = new Map();
      this.approvalRecords.set(runId, runRecords);
    }
    const records = runRecords.get(callId) || [];
    records.push({
      approval_id: input.approvalId,
      kind: 'tool',
      decision: input.decision,
      scope: 'once',
      reason: input.reason,
      reviewer: input.reviewer,
      review_reason: input.reviewReason,
      approval_mode: input.reviewer === 'auto_approve' ? 'auto_approve' : 'ai_review',
    });
    runRecords.set(callId, records);
  }

  private consumeApprovalRecords(runId: string, callId: string) {
    const runRecords = this.approvalRecords.get(runId);
    const records = runRecords?.get(callId) || [];
    runRecords?.delete(callId);
    if (runRecords?.size === 0) this.approvalRecords.delete(runId);
    return records;
  }

}

function isActiveRun(run: RuntimeRun) {
  return run.status !== 'completed'
    && run.status !== 'failed'
    && run.status !== 'cancelled'
    && run.status !== 'timeout';
}

function normalizeRunTimeout(value: number | undefined) {
  if (value === undefined) return DEFAULT_RUN_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.trunc(value), DEFAULT_RUN_TIMEOUT_MS));
}

function attachedFileContext(files: FileAttachment[]) {
  if (!files.length) return '';
  return [
    'The user attached these local files. Use the available file tools to inspect them when relevant:',
    ...files.map((file) => '- ' + file.name + ': ' + file.path),
  ].join('\n');
}

function snapshotEnvironment(
  environment: SessionEnvironment | undefined,
  defaultWorkspaceRoot: string,
): SessionEnvironment {
  return structuredClone(environment || {
    approval_mode: 'manual',
    system: {
      platform: 'other',
      arch: 'unknown',
      shell: 'unknown',
    },
    workspace: { root: defaultWorkspaceRoot },
  });
}

function safeApprovalInput(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeApprovalValue(value) as Record<string, unknown>;
}

function sanitizeApprovalValue(value: unknown, key = ''): unknown {
  if (/(api[_-]?key|token|password|secret|authorization|cookie)/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeApprovalValue(item));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    result[childKey] = sanitizeApprovalValue(childValue, childKey);
  }
  return result;
}
