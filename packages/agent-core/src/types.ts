import type { LlmClient } from '@moke/llm-client';
import type { AgentCapabilities, AgentRunInput, AgentEvent, AgentRunStatus, ToolProvider, AgentInteractionResponse, AgentRunSnapshot, AgentResult } from '@moke/agent-protocol';

export type AgentDependencies = { model: LlmClient; tools?: ToolProvider; capabilities?: Partial<AgentCapabilities> };
export type AgentRunOptions = { signal?: AbortSignal };
export interface Agent { readonly id: string; readonly capabilities: AgentCapabilities; run(input: AgentRunInput, options?: AgentRunOptions): AgentRun; }
export interface AgentRun { readonly threadId: string; readonly runId: string; status(): AgentRunStatus; events(): AsyncIterable<AgentEvent>; snapshot(): AgentRunSnapshot; result(): Promise<AgentResult>; respond(response: AgentInteractionResponse): Promise<void>; cancel(reason?: string): void; }
