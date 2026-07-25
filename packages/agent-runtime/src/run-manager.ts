import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentEventPayloadMap,
  ImageAttachment,
  Message,
  PendingApproval,
  ReasoningEffort,
  ResolvedImageAttachment,
  RunLifecycleEvent,
  RunStatus,
  Session,
  ToolApprovalRecord,
} from '@moke/protocol';
import type { Agent, RuntimeMessage } from './agent.js';
import { EventBus } from './event-bus.js';
import type { RunOrigin, RuntimeRun } from './run-state.js';
import type {
  RuntimeContentManager,
  ToolApprovalDecision,
  ToolApprovalRequest,
  WorkspacePathApprovalDecision,
  WorkspacePathApprovalRequest,
} from './tool-context.js';
import type { ToolRegistry } from './tool-registry.js';

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

type RunManagerConfig = {
  runs: Map<string, RuntimeRun>;
  agent: Agent;
  toolRegistry: ToolRegistry;
  workspace: string;
  createSkillContentManager?: () => RuntimeContentManager;
  approveWorkspaceRoot?: (root: string, scope: 'once' | 'session' | 'persistent') => (() => void) | void;
  resolveImageAttachments?: (
    attachments: ImageAttachment[],
  ) => ResolvedImageAttachment[] | Promise<ResolvedImageAttachment[]>;
  onSessionChanged?: (session: Session) => void;
};

export type RunOptions = {
  max_steps?: number;
  max_tool_calls?: number;
  reasoningEffort?: ReasoningEffort;
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
};

const MAX_RETAINED_TERMINAL_RUNS = 50;

export function selectRecentHistory(messages: Message[], maxMessages = 999) {
  if (messages.length <= maxMessages) return messages.slice();

  const cutoff = Math.max(0, messages.length - maxMessages);
  let start = cutoff;
  const cutoffMessage = messages[start];
  if (cutoffMessage?.role !== 'tool') return messages.slice(start);

  const firstToolCallId = cutoffMessage.tool_call_id;
  while (start > 0) {
    start--;
    const candidate = messages[start];
    if (candidate.role === 'assistant' && candidate.tool_calls?.some((call) => call.id === firstToolCallId)) {
      return messages.slice(start);
    }
    if (candidate.role === 'user') break;
  }

  start = cutoff;
  while (start < messages.length && messages[start]?.role === 'tool') start++;
  return messages.slice(start);
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
    }
  >();
  private readonly approvalRecords = new Map<string, Map<string, ToolApprovalRecord[]>>();
  private readonly observers = new Set<(event: AgentEvent, run: RuntimeRun) => void>();
  private readonly lifecycleObservers = new Set<(event: RunLifecycleEvent) => void>();

  constructor(private readonly config: RunManagerConfig) { }

  createRun(session: Session, input: RunMessageInput, options: RunOptions = {}) {
    if (this.shuttingDown) throw new Error('Run manager is shutting down');
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
    };

    this.config.runs.set(run.id, run);
    try {
      options.beforeStart?.(run);
    } catch (error) {
      this.config.runs.delete(run.id);
      throw error;
    }
    this.notifyLifecycle(run);
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
      this.notifyObservers(event, run);
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
      timeout_ms: options.timeout_ms || 120000,
    };
    const history = await this.resolveHistory(selectRecentHistory(session.messages.slice(0, -1)));
    const contentManager = this.config.createSkillContentManager?.();

    try {
      const result = await this.config.agent.run({
        input: input.content,
        attachments: input.attachments,
        history,
        options: {
          reasoningEffort: options.reasoningEffort,
        },
        eventBus,
        toolRegistry: this.config.toolRegistry,
        context: {
          workspace: this.config.workspace,
          run,
          abortSignal: abortController.signal,
          contentManager,
          askUser: (input) => this.askUser(run, eventBus, input),
          approveWorkspacePath: (input) => this.approveWorkspacePath(run, eventBus, input),
          approveTool: (input) => this.approveTool(run, eventBus, input),
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
    run.pending_approval = {
      approval_id: approvalId,
      ...(input.callId ? { call_id: input.callId } : {}),
      kind: 'workspace_path',
      reason: input.reason || `Allow access to ${input.suggestedRoot}?`,
      risk: input.risk,
      action: {
        tool: input.tool,
        input: input.input,
      },
      path: input.path,
      suggested_root: input.suggestedRoot,
      created_at: new Date().toISOString(),
    };
    this.setStatus(run, 'awaiting_approval');

    eventBus.emit('approval.required', run.pending_approval);
    return new Promise<WorkspacePathApprovalDecision>((resolve, reject) => {
      this.pendingApprovals.set(approvalId, {
        runId: run.id,
        resolve,
        reject,
      });
    });
  }

  private approveTool(
    run: RuntimeRun,
    eventBus: EventBus,
    input: ToolApprovalRequest,
  ): Promise<ToolApprovalDecision> {
    const approvalId = id('apv');
    run.pending_approval = {
      approval_id: approvalId,
      ...(input.callId ? { call_id: input.callId } : {}),
      kind: 'tool',
      reason: input.reason,
      risk: input.risk,
      action: {
        tool: input.tool,
        input: input.input,
      },
      created_at: new Date().toISOString(),
    };
    this.setStatus(run, 'awaiting_approval');

    eventBus.emit('approval.required', run.pending_approval);
    return new Promise<ToolApprovalDecision>((resolve, reject) => {
      this.pendingApprovals.set(approvalId, {
        runId: run.id,
        resolve,
        reject,
      });
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

    eventBus.emit('ask_user.required', run.pending_ask);

    return new Promise<{ id: string; label: string }>((resolve, reject) => {
      this.pendingAsks.set(askId, {
        runId: run.id,
        resolve,
        reject,
      });
    });
  }

  answer(runId: string, askId: string, optionId: string) {
    const run = this.config.runs.get(runId);
    if (!run) return { status: 404 as const, error: 'Run not found' };
    if (run.pending_ask?.ask_id !== askId) return { status: 409 as const, error: 'Run is not waiting for this answer' };

    const pending = this.pendingAsks.get(askId);
    if (!pending || pending.runId !== runId) return { status: 409 as const, error: 'Ask is no longer pending' };
    const selected = run.pending_ask.options.find((option) => option.id === optionId);
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
    this.notifyObservers(event, run);

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
    const scope = options.scope || 'session';
    this.recordApproval(run.id, pendingApproval, decision, scope);
    const event = new EventBus(run).emit('approval.resolved', {
      approval_id: pendingApproval.approval_id,
      decision,
      scope,
    });
    this.notifyObservers(event, run);
    const cleanupResult =
      decision === 'approved' && pendingApproval.kind === 'workspace_path' && pendingApproval.suggested_root
        ? this.config.approveWorkspaceRoot?.(pendingApproval.suggested_root, scope)
        : undefined;

    pending.resolve({
      approved: decision === 'approved',
      scope,
      message: options.message,
      cleanup: typeof cleanupResult === 'function' ? cleanupResult : undefined,
    });

    return { status: 200 as const, run };
  }

  cancel(runId: string, reason: 'user' | 'shutdown' = 'user') {
    const run = this.config.runs.get(runId);
    if (!run) return null;
    run.abort = true;
    run.cancel_reason = reason;
    this.setStatus(run, 'cancelled');
    this.abortControllers.get(runId)?.abort();
    this.abortControllers.delete(runId);

    if (run.pending_ask) {
      const pending = this.pendingAsks.get(run.pending_ask.ask_id);
      this.pendingAsks.delete(run.pending_ask.ask_id);
      run.pending_ask = undefined;
      pending?.reject(new Error('Run cancelled'));
    }

    if (run.pending_approval) {
      const pending = this.pendingApprovals.get(run.pending_approval.approval_id);
      this.pendingApprovals.delete(run.pending_approval.approval_id);
      run.pending_approval = undefined;
      pending?.reject(new Error('Run cancelled'));
    }

    const event = new EventBus(run).emit('agent.done', {
      status: 'cancelled',
      usage: {
        steps: run.seq,
        tool_calls: 0,
        duration_ms: Date.now() - run.started_at,
      },
    });
    this.notifyObservers(event, run);
    this.pruneTerminalRuns();

    return run;
  }

  addObserver(observer: (event: AgentEvent, run: RuntimeRun) => void) {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  addLifecycleObserver(observer: (event: RunLifecycleEvent) => void) {
    this.lifecycleObservers.add(observer);
    return () => this.lifecycleObservers.delete(observer);
  }

  private notifyObservers(event: AgentEvent, run: RuntimeRun) {
    for (const observer of this.observers) {
      try {
        observer(event, run);
      } catch (error) {
        console.error(`Run observer failed for ${run.id}`, error);
      }
    }
  }

  private setStatus(run: RuntimeRun, status: RunStatus) {
    if (run.status === status) return;
    run.status = status;
    this.notifyLifecycle(run);
  }

  private notifyLifecycle(run: RuntimeRun) {
    const event: RunLifecycleEvent = {
      type: run.status,
      sessionId: run.session_id,
      runId: run.id,
    };
    for (const observer of this.lifecycleObservers) {
      try {
        observer(event);
      } catch (error) {
        console.error(`Run lifecycle observer failed for ${run.id}`, error);
      }
    }
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
    });
    runRecords.set(approval.call_id, records);
  }

  private consumeApprovalRecords(runId: string, callId: string) {
    const runRecords = this.approvalRecords.get(runId);
    const records = runRecords?.get(callId) || [];
    runRecords?.delete(callId);
    if (runRecords?.size === 0) this.approvalRecords.delete(runId);
    return records;
  }

  private async resolveHistory(messages: Message[]): Promise<RuntimeMessage[]> {
    return Promise.all(messages.map(async (message): Promise<RuntimeMessage> => {
      if (message.role !== 'user') return message;
      if (!message.attachments?.length) return { ...message, attachments: undefined };
      if (!this.config.resolveImageAttachments) {
        throw new Error('Image attachment resolver is not configured');
      }
      return {
        ...message,
        attachments: await this.config.resolveImageAttachments(message.attachments),
      };
    }));
  }
}

function isActiveRun(run: RuntimeRun) {
  return run.status !== 'completed'
    && run.status !== 'failed'
    && run.status !== 'cancelled'
    && run.status !== 'timeout';
}
