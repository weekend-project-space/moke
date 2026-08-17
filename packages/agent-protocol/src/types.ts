export type JsonObject = Record<string, unknown>;
export type AgentState = JsonObject;
export type AgentRunStatus = 'queued' | 'running' | 'awaiting_approval' | 'awaiting_user' | 'completed' | 'failed' | 'cancelled';

export type TextInputContent = { type: 'text'; text: string };
export type InputContentSource =
  | { type: 'data'; value: string; mimeType: string }
  | { type: 'url'; value: string; mimeType?: string };
export type MediaInputContent = {
  type: 'image' | 'audio' | 'video' | 'document';
  source: InputContentSource;
  metadata?: JsonObject;
};
export type InputContent = TextInputContent | MediaInputContent;

export type DeveloperMessage = { id: string; role: 'developer'; content: string; name?: string };
export type SystemMessage = { id: string; role: 'system'; content: string; name?: string };
export type UserMessage = { id: string; role: 'user'; content: string | InputContent[]; name?: string };
export type AssistantMessage = { id: string; role: 'assistant'; content?: string; name?: string; toolCalls?: AgentToolCall[] };
export type ToolMessage = { id: string; role: 'tool'; content: string; toolCallId: string; error?: string; encryptedValue?: string };
export type ActivityMessage = { id: string; role: 'activity'; activityType: string; content: JsonObject };
export type ReasoningMessage = { id: string; role: 'reasoning'; content: string; encryptedValue?: string };
export type AgentMessage = DeveloperMessage | SystemMessage | UserMessage | AssistantMessage | ToolMessage | ActivityMessage | ReasoningMessage;

export type AgentContext = { description: string; value: string; role?: 'developer' | 'user' };
export type AgentToolDefinition = { name: string; description: string; parameters: JsonObject; strict?: boolean; approval?: 'none' | 'required' };
export type AgentToolCall = { id: string; type: 'function'; function: { name: string; arguments: string }; encryptedValue?: string };
export type ValidatedToolCall = AgentToolCall & { parsedArguments: JsonObject };
export type ToolExecutionContext = { threadId: string; runId: string; stepId: string; signal: AbortSignal };
export type ToolExecutionResult = {
  content: string;
  output?: unknown;
  error?: string;
  encryptedValue?: string;
  context?: AgentContext[];
  media?: MediaInputContent[];
  metadata?: Record<string, unknown>;
};
export interface ToolProvider {
  listTools(filter?: { names?: string[] }): AgentToolDefinition[];
  validate(call: AgentToolCall): ValidatedToolCall;
  execute(call: ValidatedToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export type AgentInteraction =
  | { id: string; type: 'approval'; toolCallId?: string; approvalKind: 'tool' | 'workspace_path'; reason: string; action: { tool: string; input: JsonObject }; path?: string; suggestedRoot?: string; scope?: 'once' | 'session' | 'persistent' }
  | { id: string; type: 'question'; toolCallId?: string; question: string; options?: Array<{ id: string; label: string }>; allowText: boolean };
export type AgentInteractionResponse = {
  interactionId: string;
  decision: 'approved' | 'rejected' | 'answered';
  answer?: string;
  optionId?: string;
  scope?: 'once' | 'session' | 'persistent';
  idempotencyKey: string;
};

export type AgentRunInput = {
  threadId: string;
  runId?: string;
  parentRunId?: string;
  input: string | InputContent[];
  messages?: AgentMessage[];
  state?: AgentState;
  context?: AgentContext[];
  enabledToolNames?: string[];
  limits?: Partial<AgentLimits>;
  metadata?: Record<string, string>;
};

export type JsonPatchOperation =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string };

type EventBase<T extends string> = {
  eventId: string;
  sequence: number;
  type: T;
  threadId: string;
  runId: string;
  stepId?: string;
  /** Unix epoch time in milliseconds. */
  timestamp: number;
  rawEvent?: unknown;
};

export type RunStartedEvent = EventBase<'run.started'> & { parentRunId?: string; input?: AgentRunInput };
export type RunCompletedEvent = EventBase<'run.completed'> & { result?: AgentResult; usage?: AgentUsage };
export type RunFailedEvent = EventBase<'run.failed'> & { error: AgentError };
export type RunTimedOutEvent = EventBase<'run.timed_out'> & { error: AgentError };
export type RunCancelledEvent = EventBase<'run.cancelled'> & { reason?: string };
export type StepStartedEvent = EventBase<'step.started'> & { stepName: string };
export type StepCompletedEvent = EventBase<'step.completed'> & { stepName: string };
export type MessageStartedEvent = EventBase<'message.started'> & { messageId: string; role: 'assistant' };
export type MessageContentEvent = EventBase<'message.content'> & { messageId: string; delta: string };
export type MessageCompletedEvent = EventBase<'message.completed'> & {
  messageId: string;
  message: AgentMessage;
  reasoning?: string;
};
export type ToolCallStartedEvent = EventBase<'tool_call.started'> & { toolCallId: string; toolCallName: string; parentMessageId?: string };
export type ToolCallArgsEvent = EventBase<'tool_call.args'> & { toolCallId: string; delta: string };
export type ToolCallCompletedEvent = EventBase<'tool_call.completed'> & { toolCallId: string };
export type ToolResultEvent = EventBase<'tool_result.completed' | 'tool_result.failed'> & { messageId: string; toolCallId: string; toolName?: string; content: string; output?: unknown; durationMs?: number; error?: AgentError; metadata?: Record<string, unknown> };
export type ReasoningStartedEvent = EventBase<'reasoning.started'> & { messageId: string };
export type ReasoningMessageStartedEvent = EventBase<'reasoning_message.started'> & { messageId: string; role: 'reasoning' };
export type ReasoningMessageContentEvent = EventBase<'reasoning_message.content'> & { messageId: string; delta: string };
export type ReasoningMessageCompletedEvent = EventBase<'reasoning_message.completed'> & { messageId: string };
export type ReasoningCompletedEvent = EventBase<'reasoning.completed'> & { messageId: string };
export type ReasoningEncryptedValueEvent = EventBase<'reasoning.encrypted_value'> & { subtype: 'tool-call' | 'message'; entityId: string; encryptedValue: string };
export type StateSnapshotEvent = EventBase<'state.snapshot'> & { snapshot: AgentState };
export type StateDeltaEvent = EventBase<'state.delta'> & { delta: JsonPatchOperation[] };
export type MessagesSnapshotEvent = EventBase<'messages.snapshot'> & { messages: AgentMessage[] };
export type ActivitySnapshotEvent = EventBase<'activity.snapshot'> & { messageId: string; activityType: string; content: JsonObject; replace?: boolean };
export type ActivityDeltaEvent = EventBase<'activity.delta'> & { messageId: string; activityType: string; patch: JsonPatchOperation[] };
export type InteractionRequiredEvent = EventBase<'interaction.required'> & { interaction: AgentInteraction };
export type InteractionResolvedEvent = EventBase<'interaction.resolved'> & { interactionId: string; response: AgentInteractionResponse };
export type RawEvent = EventBase<'raw'> & { event: unknown; source?: string };
export type CustomEvent = EventBase<'custom'> & { name: string; value: unknown };

export type AgentEvent =
  | RunStartedEvent | RunCompletedEvent | RunFailedEvent | RunTimedOutEvent | RunCancelledEvent
  | StepStartedEvent | StepCompletedEvent
  | MessageStartedEvent | MessageContentEvent | MessageCompletedEvent
  | ToolCallStartedEvent | ToolCallArgsEvent | ToolCallCompletedEvent | ToolResultEvent
  | ReasoningStartedEvent | ReasoningMessageStartedEvent | ReasoningMessageContentEvent
  | ReasoningMessageCompletedEvent | ReasoningCompletedEvent | ReasoningEncryptedValueEvent
  | StateSnapshotEvent | StateDeltaEvent | MessagesSnapshotEvent | ActivitySnapshotEvent | ActivityDeltaEvent
  | InteractionRequiredEvent | InteractionResolvedEvent | RawEvent | CustomEvent;

type GeneratedEventFields = 'eventId' | 'sequence' | 'threadId' | 'runId' | 'timestamp';
export type AgentEventInput = AgentEvent extends infer E ? E extends AgentEvent ? Omit<E, GeneratedEventFields> : never : never;

export type AgentLimits = { maxSteps: number; maxToolCalls: number; maxParallelToolCalls: number; maxDurationMs: number; modelTimeoutMs: number; toolTimeoutMs: number };
export type AgentCapabilities = {
  tools: { supported: boolean; parallelCalls: boolean; clientProvidedTools: false };
  output: { streaming: boolean; structured: boolean };
  reasoning: { summary: boolean; encryptedValue: boolean };
  multimodal: { input: Array<'image' | 'audio' | 'video' | 'document'> };
  execution: { cancellation: boolean; maxParallelToolCalls: number };
};
export type AgentError = { kind: 'input' | 'model' | 'tool' | 'interaction' | 'limit' | 'cancelled' | 'protocol'; code: string; message: string; retryable: boolean; stepId?: string; toolCallId?: string; details?: unknown };
export type AgentUsage = { steps: number; toolCalls: number; inputTokens: number; outputTokens: number; reasoningTokens?: number; cachedInputTokens?: number };
export type AgentRunSnapshot = { threadId: string; runId: string; status: AgentRunStatus; messages: AgentMessage[]; state: AgentState; activities: ActivityMessage[]; lastSequence: number; pendingInteraction?: AgentInteraction; usage: AgentUsage };
export type AgentRunCheckpoint = { version: 1; threadId: string; runId: string; status: 'awaiting_approval' | 'awaiting_user'; nextStepIndex: number; messages: AgentMessage[]; state: AgentState; usage: AgentUsage; pendingInteraction: AgentInteraction; pendingToolCalls: ValidatedToolCall[] };
export type AgentResult = { threadId: string; runId: string; status: 'completed'; message: AssistantMessage; messages: AgentMessage[]; state: AgentState; usage: AgentUsage };
