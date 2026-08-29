import type {
  AssistantMessage,
  ImageAttachmentUpload,
  FileAttachmentInput,
  PendingApproval,
  PendingAsk,
  RuntimeLimits,
  RunLifecycleEvent,
  SessionVisibility,
  CreateSessionEnvironmentInput,
  SendMessageEnvironmentInput,
  UpdateSessionEnvironmentInput,
} from '@moke/protocol';
import type { AgentEvent } from '@moke/agent-protocol';
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
  includeHidden?: boolean;
};

export type WorkspaceEntry = {
  path: string;
  name: string;
};

export type WorkspaceEntriesInput = RequestOptions & {
  /** Existing Session whose immutable workspace should be used. */
  sessionId?: string;
  /** Temporary workspace context returned by `workspace.createContext()`. */
  contextId?: string;
  path?: string;
  query?: string;
  includeDirectories?: boolean;
  limit?: number;
};

export type CreateWorkspaceContextInput = {
  workspaceRoot: string;
  ttlMs?: number;
};

export type WorkspaceContext = {
  id: string;
  root: string;
  expiresAt?: string;
};

export type ListSkillsInput = RequestOptions & {
  /** Existing Session whose workspace skill catalog should be used. */
  sessionId?: string;
  /** Temporary workspace context returned by `workspace.createContext()`. */
  contextId?: string;
  enabledOnly?: boolean;
};

export type SkillSummary = {
  name: string;
  description: string;
};

export type ModelSummary = {
  name: string;
  alias?: string;
  supportsReasoning?: boolean;
};

export type ModelProviderModels = {
  provider: string;
  providerName?: string;
  models: ModelSummary[];
};

export type ListModelsOptions = RequestOptions & {
  providerId?: string;
  refresh?: boolean;
};

export type CreateSessionInput = {
  title?: string;
  metadata?: Record<string, unknown>;
  visibility?: SessionVisibility;
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
  files?: FileAttachmentInput[];
  limits?: Partial<RuntimeLimits>;
  env?: SendMessageEnvironmentInput;
};

export type PromptInput = SendMessageInput;

export type AnswerRunInput = {
  requestId: string;
} & ({ optionId: string } | { customText: string });

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
  onAsk?: (request: PendingAsk, context: RunContext) => Promise<string | { optionId: string } | { customText: string }>;
  onApproval?: (request: PendingApproval, context: RunContext) => Promise<ApprovalDecision>;
};

export type InteractionHandlerOverrides = {
  [Key in keyof InteractionHandlers]?: InteractionHandlers[Key] | null;
};

export type ChatOptions = RequestOptions & {
  handlers?: InteractionHandlerOverrides;
};
