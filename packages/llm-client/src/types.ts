export type LlmProvider = 'openai-responses' | 'openai-chat-completions' | 'openai-compatible';

export type JsonSchema = Record<string, unknown>;

export type InputContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'file'; fileId: string };

export type ChatInputItem =
  | {
      type: 'message';
      role: 'system' | 'developer' | 'user' | 'assistant';
      content: string | InputContentPart[];
    }
  | {
      type: 'tool_call';
      callId: string;
      name: string;
      arguments: string | Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      callId: string;
      output: unknown;
    };

export type ToolDefinition = {
  type: 'function';
  name: string;
  description?: string;
  parameters: JsonSchema;
  strict?: boolean;
};

export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string };

export type ChatRequest = {
  input: string | ChatInputItem[];
  model?: string;
  instructions?: string;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  reasoning?: { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  previousResponseId?: string;
  store?: boolean;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  providerOptions?: Record<string, unknown>;
};

export type OpenAiCompatibleOptions = {
  endpoint?: string;
  supportsDeveloperRole?: boolean;
  supportsStreamUsage?: boolean;
  supportsParallelToolCalls?: boolean;
  reasoningFormat?: 'none' | 'reasoning_content' | 'think-tags';
};

export type LlmDiagnostics = {
  onHandlerError?: (error: unknown, event: LlmStreamEvent) => void;
};

export type LlmClientOptions = {
  provider: LlmProvider;
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  store?: boolean;
  compatible?: OpenAiCompatibleOptions;
  diagnostics?: LlmDiagnostics;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
};

export type ToolCall = {
  callId: string;
  name: string;
  argumentsJson: string;
  arguments: Record<string, unknown>;
};

export type ChatOutputItem =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; visibility: 'summary' | 'provider_exposed' }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'refusal'; text: string }
  | { type: 'unknown'; raw: unknown };

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'incomplete' | 'unknown';

export type ChatResponse = {
  id: string;
  runId: string;
  model: string;
  provider: string;
  status: 'completed';
  text: string;
  output: ChatOutputItem[];
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  finishReason?: FinishReason;
  providerRequestId?: string;
  rawResponse?: unknown;
};

export type ProviderEventMetadata = {
  name: string;
  requestId?: string;
  eventType?: string;
};

type EventEnvelope<TType extends string, TPayload> = {
  version: 1;
  type: TType;
  runId: string;
  sequence: number;
  timestamp: string;
  responseId?: string;
  itemId?: string;
  provider: ProviderEventMetadata;
  payload: TPayload;
};

export type LlmStreamEvent =
  | EventEnvelope<'run.started', { responseId?: string }>
  | EventEnvelope<'text.delta', { delta: string; outputIndex?: number; contentIndex?: number }>
  | EventEnvelope<'text.completed', { text: string }>
  | EventEnvelope<'thinking.delta', { delta: string; visibility: 'summary' | 'provider_exposed' }>
  | EventEnvelope<'thinking.completed', { text: string; visibility: 'summary' | 'provider_exposed' }>
  | EventEnvelope<'tool_call.delta', { callId: string; name?: string; argumentsDelta: string }>
  | EventEnvelope<'tool_call.completed', ToolCall>
  | EventEnvelope<'usage.updated', TokenUsage>
  | EventEnvelope<'provider.raw', { provider: string; type: string; raw: unknown }>
  | EventEnvelope<'run.completed', ChatResponse>
  | EventEnvelope<'run.failed', LlmClientError>
  | EventEnvelope<'run.cancelled', { reason?: string }>;

export type StreamEventContext = Omit<LlmStreamEvent, 'type' | 'payload'> & {
  outputIndex?: number;
  contentIndex?: number;
};

export interface StreamingChatResponseHandler {
  onStarted?(event: { responseId?: string }, context: StreamEventContext): void;
  onTextDelta?(delta: { text: string }, context: StreamEventContext): void;
  onTextCompleted?(text: { text: string }, context: StreamEventContext): void;
  onThinkingDelta?(delta: { text: string; visibility: 'summary' | 'provider_exposed' }, context: StreamEventContext): void;
  onThinkingCompleted?(thinking: { text: string; visibility: 'summary' | 'provider_exposed' }, context: StreamEventContext): void;
  onToolCallDelta?(delta: { callId: string; name?: string; argumentsDelta: string }, context: StreamEventContext): void;
  onToolCallCompleted?(toolCall: ToolCall, context: StreamEventContext): void;
  onUsageUpdated?(usage: TokenUsage, context: StreamEventContext): void;
  onUnmappedRawEvent?(event: { provider: string; type: string; raw: unknown }, context: StreamEventContext): void;
  onCompleted(response: ChatResponse): void;
  onFailed(error: LlmClientError): void;
  onCancelled?(cancellation: { reason?: string }): void;
}

export type LlmErrorKind =
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'invalid_request'
  | 'unsupported_feature'
  | 'transport'
  | 'timeout'
  | 'provider'
  | 'protocol'
  | 'cancelled';

export class LlmClientError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly provider?: string;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(message: string, options: {
    kind: LlmErrorKind;
    retryable?: boolean;
    statusCode?: number;
    provider?: string;
    providerCode?: string;
    providerRequestId?: string;
    retryAfterMs?: number;
    details?: unknown;
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = 'LlmClientError';
    this.kind = options.kind;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    this.provider = options.provider;
    this.providerCode = options.providerCode;
    this.providerRequestId = options.providerRequestId;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

export type ChatRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ChatRunSnapshot = {
  id: string;
  status: ChatRunStatus;
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  responseId?: string;
  startedAt?: string;
  completedAt?: string;
};

export interface ChatRun {
  readonly id: string;
  status(): ChatRunStatus;
  snapshot(): ChatRunSnapshot;
  events(): AsyncIterable<LlmStreamEvent>;
  result(): Promise<ChatResponse>;
  cancel(reason?: string): void;
}

export interface LlmClient {
  readonly provider: string;
  readonly defaultModel: string;
  chat(input: string | ChatRequest, handler?: StreamingChatResponseHandler): ChatRun;
  complete(input: string | ChatRequest): Promise<ChatResponse>;
}
