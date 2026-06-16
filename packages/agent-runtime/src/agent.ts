import type { Message, RuntimeLimits } from '../../protocol/src/index.js';
import type { EventBus } from './event-bus.js';
import type { ToolContext } from './tool-context.js';
import type { ToolRegistry } from './tool-registry.js';

export type AgentRunInput = {
  input: string;
  history?: Message[];
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
