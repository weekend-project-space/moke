import type { AgentStep, ResolvedImageAttachment, TokenUsage, ToolCall } from '@moke/protocol';
import type { AgentRunInput, RuntimeContextItem, RuntimeMessage, RuntimeToolImage } from '@moke/agent-runtime';
import type { AgentToolSpec } from './control-tools.js';

export type ModelConversationState = {
  langchain?: import('@langchain/core/messages').BaseMessage[];
  responses?: ResponsesInputItem[];
};

export type ModelStepInput = {
  eventBus: AgentRunInput['eventBus'];
  input: string;
  attachments: ResolvedImageAttachment[];
  context: AgentRunInput['context'];
  history: RuntimeMessage[];
  messages: ModelConversationState;
  runtimeTools: AgentToolSpec[];
  showRawReasoning: boolean;
  step?: AgentStep;
  signal?: AbortSignal;
  timeoutMs: number;
};

export type ModelStepResult = {
  content: string;
  contentStreamed: boolean;
  message: unknown;
  reasoning: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
};

export type ModelAdapter = {
  createInitialState(input: {
    context: AgentRunInput['context'];
    history: RuntimeMessage[];
    input: string;
    attachments: ResolvedImageAttachment[];
    runtimeTools: AgentToolSpec[];
  }): ModelConversationState;
  appendToolResult(state: ModelConversationState, input: {
    callId: string;
    name: string;
    output: unknown;
    images?: RuntimeToolImage[];
    status?: 'error' | 'success';
  }): void;
  appendContext(state: ModelConversationState, context: RuntimeContextItem[]): void;
  streamStep(input: ModelStepInput): Promise<ModelStepResult>;
};

export type ResponseContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string };

export type ResponsesInputItem =
  | { role: 'developer' | 'system' | 'user' | 'assistant'; content: string | ResponseContentItem[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export type ResponsesStreamEvent = {
  event: string;
  data: unknown;
};

export function toToolCallArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}
