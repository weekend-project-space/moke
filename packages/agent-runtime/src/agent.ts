import type {
  AssistantMessage,
  Message,
  ReasoningEffort,
  ResolvedImageAttachment,
  RuntimeLimits,
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
  limits: RuntimeLimits;
};

export type AgentRunResult = {
  toolCalls: number;
  message: Message;
};

export type Agent = {
  run(input: AgentRunInput): Promise<AgentRunResult>;
};
