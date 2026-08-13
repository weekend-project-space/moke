import { randomUUID } from 'node:crypto';

import { createAgent } from '@moke/agent-core';
import type {
  AgentEvent as CoreAgentEvent,
  AgentMessage as CoreAgentMessage,
  AgentToolCall,
  InputContent,
  ToolProvider,
  ValidatedToolCall,
} from '@moke/agent-protocol';
import {
  normalizeRuntimeToolResult,
  ToolExecutionError,
  type Agent,
  type AgentRunInput,
  type AgentRunResult,
} from '@moke/agent-runtime';
import { createLlmClient, type LlmClientOptions } from '@moke/llm-client';
import type { AssistantMessage, ModelSelection, TokenUsage } from '@moke/protocol';
import { z } from 'zod';

import type { ChatModelSettings } from '../storage/settings.js';

const ASK_USER_TOOL = {
  name: 'ask_user',
  description: 'Pause the current run to ask the user one question with 2 to 5 concrete options.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
} as const;

const SYSTEM_PROMPT = `You are Moke, a local-first tool-using agent.
Answer directly when no tool is needed. Use tools only when the request requires them.
Prefer Chinese when the user writes Chinese. Never invent file contents you did not observe.
Do not expose hidden chain-of-thought or <think> blocks. Use ask_user only when a decision is required to continue.`;

export function toLlmClientOptions(settings: ChatModelSettings): LlmClientOptions {
  return {
    provider: settings.type,
    apiKey: settings.apiKey,
    baseUrl: settings.apiBaseUrl,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    ...(settings.type === 'openai-compatible'
      ? {
          compatible: {
            reasoningFormat: settings.reasoningProvider === 'llama.cpp' ? 'reasoning_content' : 'none',
            supportsDeveloperRole: false,
          },
        }
      : {}),
  };
}

export class CoreAgentAdapter implements Agent {
  constructor(private readonly getModelSettings: (selection?: ModelSelection) => Partial<ChatModelSettings>) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const settings = resolveSettings(this.getModelSettings(input.context.run?.env.model));
    if (input.context.run?.env.reasoningEffort) settings.reasoningEffort = input.context.run.env.reasoningEffort;
    const model = createLlmClient(toLlmClientOptions(settings));
    const tools = new RuntimeToolProvider(input);
    const agent = createAgent({
      model,
      tools,
      capabilities: {
        tools: { supported: true, parallelCalls: false, clientProvidedTools: false },
        execution: { cancellation: true, maxParallelToolCalls: 1 },
      },
    });
    const run = agent.run({
      threadId: input.context.run?.session_id ?? randomUUID(),
      runId: input.context.run?.id,
      input: toInput(input.input, input.attachments),
      messages: toHistory(input.history ?? []),
      context: buildContext(input),
      limits: {
        maxSteps: clamp(input.limits.max_steps, 1, 1000),
        maxToolCalls: clamp(input.limits.max_tool_calls, 0, 200),
        maxParallelToolCalls: 1,
        modelTimeoutMs: settings.timeoutMs,
      },
      metadata: {
        reasoningEffort: settings.reasoningEffort,
        showRawReasoning: String(settings.showRawReasoning),
      },
    }, { signal: input.context.abortSignal });

    const eventTask = forwardCoreEvents(run.events(), input);
    const result = await run.result();
    const completedMessages = await eventTask;
    const message = completedMessages.get(result.message.id) ?? toRuntimeAssistant(result.message);
    return {
      toolCalls: result.usage.toolCalls,
      message,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        ...(result.usage.cachedInputTokens !== undefined ? { cached_input_tokens: result.usage.cachedInputTokens } : {}),
      },
    };
  }
}

class RuntimeToolProvider implements ToolProvider {
  constructor(private readonly input: AgentRunInput) {}

  listTools(filter?: { names?: string[] }) {
    const names = filter?.names ? new Set(filter.names) : undefined;
    const tools = this.input.toolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? (z.toJSONSchema(tool.schema) as Record<string, unknown>),
      approval: tool.approval,
    }));
    const all = [ASK_USER_TOOL, ...tools];
    return names ? all.filter((tool) => names.has(tool.name)) : all;
  }

  validate(call: AgentToolCall): ValidatedToolCall {
    let parsedArguments: Record<string, unknown>;
    try {
      const value = JSON.parse(call.function.arguments || '{}') as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('arguments must be an object');
      parsedArguments = value as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Invalid arguments for ${call.function.name}`, { cause: error });
    }
    return { ...call, parsedArguments };
  }

  async execute(call: ValidatedToolCall) {
    const startedAt = Date.now();
    const name = call.function.name;
    try {
      const raw = name === ASK_USER_TOOL.name
        ? await this.askUser(call)
        : await this.input.toolRegistry.execute(name, call.parsedArguments, {
            ...this.input.context,
            currentToolCall: { callId: call.id, tool: name, input: call.parsedArguments },
          });
      const normalized = normalizeRuntimeToolResult(raw);
      const approvals = this.input.context.consumeApprovals?.(call.id) ?? [];
      for (const item of normalized.context) {
        if (item.scope !== 'session' || item.authority !== 'user') continue;
        this.input.eventBus.emit({ type: 'custom', name: 'moke.internal.message', value: { id: `msg_${randomUUID()}`, role: 'user', content: item.content } });
      }
      return {
        content: JSON.stringify(normalized.publicOutput),
        output: normalized.modelOutput,
        metadata: { publicOutput: normalized.publicOutput, durationMs: Date.now() - startedAt, approvals },
        context: normalized.context.map((item) => ({
          description: `${item.authority} tool context`,
          value: item.content,
          role: item.authority === 'user' ? 'user' as const : 'developer' as const,
        })),
        media: normalized.images.map((image) => ({
          type: 'image' as const,
          source: { type: 'url' as const, value: image.data_url },
        })),
      };
    } catch (error) {
      if (this.input.context.abortSignal?.aborted) throw error;
      const output = error instanceof ToolExecutionError
        ? error.output
        : { error: { code: 'TOOL_FAILED', message: error instanceof Error ? error.message : String(error), tool: name } };
      const approvals = this.input.context.consumeApprovals?.(call.id) ?? [];
      return { content: JSON.stringify(output), output, error: error instanceof Error ? error.message : String(error), metadata: { publicOutput: output, durationMs: Date.now() - startedAt, approvals } };
    }
  }

  private async askUser(call: ValidatedToolCall) {
    if (!this.input.context.askUser) throw new Error('ask_user is unavailable');
    const question = typeof call.parsedArguments.question === 'string' && call.parsedArguments.question.trim()
      ? call.parsedArguments.question.trim() : '请选择下一步。';
    const options = normalizeOptions(call.parsedArguments.options);
    const selected = await this.input.context.askUser({ callId: call.id, question, options });
    return { question, selected, status: 'answered' };
  }

}

export async function forwardCoreEvents(events: AsyncIterable<CoreAgentEvent>, input: Pick<AgentRunInput, 'eventBus'>) {
  const completedMessages = new Map<string, AssistantMessage>();
  for await (const event of events) {
    input.eventBus.emit(toEventInput(event), { timestamp: event.timestamp });
    if (event.type === 'message.completed' && event.message.role === 'assistant') {
      const message = toRuntimeAssistant(event.message, event.timestamp, event.reasoning);
      completedMessages.set(message.id, message);
    }
  }
  return completedMessages;
}

function toEventInput(event: CoreAgentEvent) {
  const { eventId: _eventId, sequence: _sequence, threadId: _threadId, runId: _runId, timestamp: _timestamp, ...input } = event;
  return input;
}

function buildContext(input: AgentRunInput) {
  const items = [
    { description: 'System instructions', value: SYSTEM_PROMPT },
    ...(input.context.trustedContext ?? []).map((item) => ({
      description: `${item.authority} runtime context`,
      value: item.content,
      role: item.authority === 'user' ? 'user' as const : 'developer' as const,
    })),
    ...(input.context.contentManager?.buildInitialContext() ?? []).map((item) => ({
      description: `${item.authority} skill context`,
      value: item.content,
      role: item.authority === 'user' ? 'user' as const : 'developer' as const,
    })),
  ];
  return items;
}

function toInput(text: string, attachments: AgentRunInput['attachments'] = []): string | InputContent[] {
  if (!attachments.length) return text;
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...attachments.map((attachment) => ({
      type: 'image' as const,
      source: { type: 'url' as const, value: attachment.data_url, mimeType: attachment.mime_type },
    })),
  ];
}

function toHistory(history: NonNullable<AgentRunInput['history']>): CoreAgentMessage[] {
  return history.map((message): CoreAgentMessage => {
    if (message.role === 'user') return { id: message.id, role: 'user', content: toInput(message.content, message.attachments) };
    if (message.role === 'tool') return { id: message.id, role: 'tool', content: message.content, toolCallId: message.tool_call_id, ...(message.status === 'error' ? { error: message.content } : {}) };
    return {
      id: message.id,
      role: 'assistant',
      content: message.content,
      ...(message.tool_calls?.length ? { toolCalls: message.tool_calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}),
    };
  });
}

function toRuntimeAssistant(message: Extract<CoreAgentMessage, { role: 'assistant' }>, createdAt: string | number = new Date().toISOString(), reasoning?: string): AssistantMessage {
  const createdAtText = typeof createdAt === 'number' ? new Date(createdAt).toISOString() : createdAt;
  return {
    id: message.id,
    role: 'assistant',
    content: message.content ?? '',
    created_at: createdAtText,
    ...(reasoning ? { reasoning } : {}),
    ...(message.toolCalls?.length ? {
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        args: parseToolArguments(call.function.arguments),
      })),
    } : {}),
  };
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeOptions(value: unknown) {
  const options = Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean).slice(0, 5)
    : [];
  const labels = options.length >= 2 ? options : ['继续', '取消'];
  return labels.map((label, index) => ({ id: `option_${index + 1}`, label }));
}

function resolveSettings(input: Partial<ChatModelSettings>): ChatModelSettings {
  return {
    apiKey: input.apiKey ?? '',
    apiBaseUrl: input.apiBaseUrl ?? 'https://api.openai.com/v1',
    maxRetries: input.maxRetries ?? 3,
    model: input.model ?? 'gpt-4o-mini',
    type: input.type ?? 'openai-compatible',
    reasoningEffort: input.reasoningEffort ?? 'medium',
    reasoningProvider: input.reasoningProvider ?? 'none',
    showRawReasoning: input.showRawReasoning ?? false,
    timeoutMs: input.timeoutMs ?? 120_000,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.trunc(value), max));
}
