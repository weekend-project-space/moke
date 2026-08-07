import type {
  AssistantMessage,
  Message,
  ReasoningEffort,
  ResolvedImageAttachment,
  RuntimeLimits,
  TokenUsage,
  ToolMessage,
  UserMessage,
} from '@moke/protocol';
import type { EventBus } from './event-bus.js';
import type { ToolContext } from './tool-context.js';
import type { ToolRegistry } from './tool-registry.js';

export type RuntimeUserMessage = Omit<UserMessage, 'attachments'> & {
  attachments?: ResolvedImageAttachment[];
};

export type RuntimeMessage = RuntimeUserMessage | AssistantMessage | ToolMessage;

export type AgentRunInput = {
  input: string;
  attachments?: ResolvedImageAttachment[];
  history?: RuntimeMessage[];
  options?: {
    reasoningEffort?: ReasoningEffort;
  };
  eventBus: EventBus;
  toolRegistry: ToolRegistry;
  context: ToolContext;
  limits: Pick<RuntimeLimits, 'max_steps' | 'max_tool_calls'>;
};

export type AgentRunResult = {
  toolCalls: number;
  message: Message;
  usage?: TokenUsage;
};

export type Agent = {
  run(input: AgentRunInput): Promise<AgentRunResult>;
};
