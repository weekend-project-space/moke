import type {
  AgentEvent,
  AssistantMessage,
  ImageAttachmentUpload,
  PendingApproval,
  PendingAsk,
  ReasoningEffort,
  RuntimeLimits,
  RunLifecycleEvent,
  CreateSessionEnvironmentInput,
  SendMessageEnvironmentInput,
  UpdateSessionEnvironmentInput,
} from '@moke/protocol';
import type { RunHandle, SessionHandle } from './client.js';

export type MokeClientOptions = {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
  userAgent?: string;
};

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ListSessionsOptions = RequestOptions & {
  includeArchived?: boolean;
};

export type CreateSessionInput = {
  title?: string;
  metadata?: Record<string, unknown>;
  env?: CreateSessionEnvironmentInput;
};

export type { UpdateSessionEnvironmentInput } from '@moke/protocol';

export type UpdateSessionInput = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
};

export type ForkSessionInput = {
  messageId: string;
  mode?: 'after';
};

export type SendMessageInput = {
  content: string;
  attachments?: ImageAttachmentUpload[];
  reasoningEffort?: ReasoningEffort;
  limits?: Partial<RuntimeLimits>;
  env?: SendMessageEnvironmentInput;
};

export type PromptInput = SendMessageInput;

export type AnswerRunInput = {
  requestId: string;
  optionId: string;
};

export type ApproveRunInput = {
  requestId: string;
  decision: 'approved' | 'rejected';
  scope?: 'once' | 'session' | 'persistent';
  message?: string;
};

export type RunEventsOptions = RequestOptions & {
  afterSeq?: number;
  reconnect?: boolean;
  maxReconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  onReconnect?: (attempt: number, delayMs: number) => void;
};

export type RunResult = {
  runId: string;
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  message?: AssistantMessage;
  usage?: {
    steps: number;
    toolCalls: number;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    uncachedInputTokens?: number;
  };
  error?: { code: string; message: string };
};

export type RunResultOptions = RequestOptions;

export type RunLifecycleListener = (event: RunLifecycleEvent) => void;

export type RunLifecycleOptions = {
  signal?: AbortSignal;
  onReconnect?: () => void;
  onError?: (error: unknown) => void;
};

export type SessionRunEventListener = (event: AgentEvent, run: RunHandle) => void;

export type SessionRunEventOptions = {
  signal?: AbortSignal;
  onReconnect?: (run: RunHandle, attempt: number, delayMs: number) => void;
  onError?: (error: unknown) => void;
};

export type RunContext = {
  run: RunHandle;
  session: SessionHandle;
};

export type ApprovalDecision = {
  decision: 'approved' | 'rejected';
  scope?: 'once' | 'session' | 'persistent';
  message?: string;
};

export type InteractionHandlers = {
  onEvent?: (event: AgentEvent, context: RunContext) => void | Promise<void>;
  onAsk?: (request: PendingAsk, context: RunContext) => Promise<string | { optionId: string }>;
  onApproval?: (request: PendingApproval, context: RunContext) => Promise<ApprovalDecision>;
};

export type InteractionHandlerOverrides = {
  [Key in keyof InteractionHandlers]?: InteractionHandlers[Key] | null;
};

export type PromptOptions = RequestOptions & {
  handlers?: InteractionHandlerOverrides;
};
