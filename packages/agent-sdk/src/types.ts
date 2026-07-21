import type {
  AgentEvent,
  AssistantMessage,
  ImageAttachmentUpload,
  PendingApproval,
  PendingAsk,
  ReasoningEffort,
  RuntimeLimits,
} from '@moke/protocol';
import type { RunHandle, SessionHandle } from './client.js';

export type MokeClientOptions = {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
};

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CreateSessionInput = {
  title?: string;
  metadata?: Record<string, unknown>;
};

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
};

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
  };
  error?: { code: string; message: string };
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
