import { AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from 'langchain';
import { randomUUID } from 'node:crypto';

import type { AgentStep, ResolvedImageAttachment, TokenUsage, ToolCall } from '@moke/protocol';
import type { AgentRunInput, RuntimeContextItem, RuntimeMessage, RuntimeToolImage } from '@moke/agent-runtime';
import type { AgentToolSpec } from './control-tools.js';
import {
  createHistoryMessages,
  createRuntimeContextMessages,
  createSystemPrompt,
  createSystemMessage,
  createThinkTagSplitter,
  createUserMessage,
  getMessageText,
  getReasoningText,
  isAI,
} from './messages.js';
import { createChatModel, type ChatModelSettings, withTimeout } from './llm-client.js';
import {
  type ModelAdapter,
  type ModelConversationState,
  type ModelStepInput,
  type ModelStepResult,
  type ResponseContentItem,
  type ResponsesInputItem,
  toToolCallArgs,
} from './model-adapter-types.js';
import { collectResponseOutput, collectTextValue, readSseEvents } from './responses-stream.js';

export type { ModelAdapter, ModelConversationState, ModelStepInput, ModelStepResult } from './model-adapter-types.js';

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Run cancelled');
}

function createModelTool(runtimeTool: AgentToolSpec) {
  return tool(
    async () => {
      throw new Error(`Tool ${runtimeTool.name} is executed by the ReAct runtime loop.`);
    },
    {
      name: runtimeTool.name,
      description: runtimeTool.description,
      schema: runtimeTool.schema,
    },
  );
}

type ResponsesFunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

function resolveResponsesUrl(apiBaseUrl: string) {
  const base = apiBaseUrl.replace(/\/+$/, '');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

function stringifyToolOutput(output: unknown) {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function tokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeTokenUsage(value: unknown, fallback?: unknown): TokenUsage | undefined {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const metadata = fallback && typeof fallback === 'object' ? fallback as Record<string, unknown> : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown>
    : usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
      ? usage.prompt_tokens_details as Record<string, unknown>
      : metadata.input_token_details && typeof metadata.input_token_details === 'object'
        ? metadata.input_token_details as Record<string, unknown>
        : {};
  const inputTokens = tokenCount(usage.input_tokens ?? usage.prompt_tokens ?? metadata.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens ?? usage.completion_tokens ?? metadata.output_tokens);
  const cachedInputTokens = tokenCount(
    usage.prompt_cache_hit_tokens ?? inputDetails.cached_tokens ?? inputDetails.cache_read,
  );
  const uncachedInputTokens = tokenCount(
    usage.prompt_cache_miss_tokens ?? inputDetails.cache_creation,
  ) ?? (inputTokens !== undefined && cachedInputTokens !== undefined
    ? Math.max(0, inputTokens - cachedInputTokens)
    : undefined);
  const normalized = {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cached_input_tokens: cachedInputTokens } : {}),
    ...(uncachedInputTokens !== undefined ? { uncached_input_tokens: uncachedInputTokens } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function messageTokenUsage(message: AIMessageChunk) {
  const responseMetadata = message.response_metadata as Record<string, unknown>;
  return normalizeTokenUsage(responseMetadata.usage, message.usage_metadata);
}

function responsesTokenUsage(output: unknown[]) {
  for (let index = output.length - 1; index >= 0; index--) {
    const item = output[index];
    if (!item || typeof item !== 'object') continue;
    const usage = normalizeTokenUsage((item as Record<string, unknown>).usage);
    if (usage) return usage;
  }
  return undefined;
}

function createJsonSchemaForTool(runtimeTool: AgentToolSpec): Record<string, unknown> {
  if (runtimeTool.input_schema && typeof runtimeTool.input_schema === 'object') return runtimeTool.input_schema;
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function createResponsesTools(runtimeTools: AgentToolSpec[]): ResponsesFunctionTool[] {
  return runtimeTools.map((runtimeTool) => ({
    type: 'function',
    name: runtimeTool.name,
    description: runtimeTool.description,
    parameters: createJsonSchemaForTool(runtimeTool),
  }));
}

function createResponsesReasoning(settings: ChatModelSettings): { effort: string } | undefined {
  if (settings.reasoningEffort === 'off') return { effort: 'none' };
  if (settings.reasoningEffort === 'max') return { effort: 'max' };
  return { effort: settings.reasoningEffort };
}

function createResponsesUserContent(content: string, attachments: ResolvedImageAttachment[]): ResponseContentItem[] {
  return [
    ...(content ? [{ type: 'input_text' as const, text: content }] : []),
    ...attachments.map((attachment) => ({
      type: 'input_image' as const,
      image_url: attachment.data_url,
    })),
  ];
}

function emitToolCreated(input: Pick<ModelStepInput, 'eventBus' | 'runtimeTools' | 'step'>, callId: string, name: string) {
  const runtimeTool = input.runtimeTools.find((tool) => tool.name === name)
  input.eventBus.emit('tool.call.created', {
    call_id: callId,
    tool: name,
    source: runtimeTool?.source || { type: 'local' },
  }, { step: input.step })
}

function parseToolArguments(value: string | undefined) {
  if (!value?.trim()) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function normalizeStreamToolCalls(calls: Array<{
  id?: string;
  name?: string;
  args?: unknown;
}>): ToolCall[] {
  const normalized: ToolCall[] = [];

  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    if (!call) continue;
    const name = call.name?.trim() || '';
    const args = toToolCallArgs(call.args);
    if (name) {
      normalized.push({ id: call.id || '', name, args });
      continue;
    }

    const previous = normalized.at(-1);
    const previousRawName = calls[index - 1]?.name?.trim();
    if (previous && previousRawName && Object.keys(previous.args).length === 0 && Object.keys(args).length > 0) {
      previous.args = args;
    }
  }

  return normalized;
}

function createResponsesHistoryMessages(history: RuntimeMessage[]): ResponsesInputItem[] {
  const messages: ResponsesInputItem[] = [];
  const knownToolCallIds = new Set<string>();

  for (const message of history) {
    if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: createResponsesUserContent(message.content.trim(), message.attachments || []),
      });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content.trim()) {
        messages.push({
          role: 'assistant',
          content: message.content.trim(),
        });
      }
      for (const call of message.tool_calls || []) {
        knownToolCallIds.add(call.id);
        messages.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args || {}),
        });
      }
      continue;
    }

    if (message.role === 'tool') {
      if (!knownToolCallIds.has(message.tool_call_id)) continue;
      messages.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      });
      knownToolCallIds.delete(message.tool_call_id);
    }
  }

  return messages;
}

function createResponsesContextItems(context: RuntimeContextItem[]): ResponsesInputItem[] {
  return context.map((item) => ({
    role: item.authority === 'trusted' ? 'developer' : 'user',
    content: item.content,
  }));
}

async function readErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as { error?: { message?: unknown }; message?: unknown };
    const message = data.error?.message || data.message;
    return typeof message === 'string' && message.trim() ? message.trim() : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

type StreamableChatModel = {
  stream(
    input: BaseMessage[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AIMessageChunk> | Promise<AsyncIterable<AIMessageChunk>>;
};

async function streamChatModel(input: {
  eventBus: AgentRunInput['eventBus'];
  runtimeTools: AgentToolSpec[];
  messages: BaseMessage[];
  model: StreamableChatModel;
  showRawReasoning: boolean;
  step?: AgentStep;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  const chunks: AIMessageChunk[] = [];
  const thinkTags = createThinkTagSplitter();
  let previousReasoningText = '';
  let reasoning = '';
  let contentStreamed = false;
  const toolStreams = new Map<string, { callId: string; name: string; args: string; created: boolean; ready: boolean }>();

  function updateToolChunks(chunk: AIMessageChunk) {
    const chunks = (chunk as AIMessageChunk & { tool_call_chunks?: Array<{ id?: string; name?: string; args?: string; index?: number }> }).tool_call_chunks || []
    for (const toolChunk of chunks) {
      const key = `index:${toolChunk.index ?? 0}`
      const current = toolStreams.get(key) || {
        callId: toolChunk.id || `call_${randomUUID().slice(0, 8)}`,
        name: '',
        args: '',
        created: false,
        ready: false,
      }
      if (toolChunk.id) current.callId = toolChunk.id
      if (toolChunk.name?.trim()) {
        const name = toolChunk.name.trim()
        if (!current.name) current.name = name
        else if (!name.startsWith(current.name)) current.name += name
      }
      const hasCompleteName = input.runtimeTools.some((tool) => tool.name === current.name)
      if (!current.created && current.callId && hasCompleteName) {
        emitToolCreated(input, current.callId, current.name)
        current.created = true
      }
      if (toolChunk.args) current.args += toolChunk.args
      if (current.created && !current.ready && current.callId) {
        const args = parseToolArguments(current.args)
        if (args) {
          current.ready = true
          input.eventBus.emit('tool.call.ready', { call_id: current.callId, input: args }, { step: input.step })
        }
      }
      toolStreams.set(key, current)
    }
  }

  function emitReasoning(content: string) {
    if (!content || !input.showRawReasoning) return;
    reasoning += content;
    input.eventBus.emit('agent.message.delta', { channel: 'reasoning', content }, { step: input.step });
  }

  await withTimeout(
    (async () => {
      const stream = await input.model.stream(input.messages, { signal: input.signal });

      for await (const chunk of stream) {
        throwIfAborted(input.signal);
        chunks.push(chunk);
        updateToolChunks(chunk);

        const reasoningText = getReasoningText(chunk);
        if (reasoningText && input.showRawReasoning) {
          const reasoningDelta = reasoningText.startsWith(previousReasoningText)
            ? reasoningText.slice(previousReasoningText.length)
            : reasoningText;
          previousReasoningText = reasoningText.startsWith(previousReasoningText)
            ? reasoningText
            : `${previousReasoningText}${reasoningText}`;
          emitReasoning(reasoningDelta);
        }

        const split = thinkTags.consume(getMessageText(chunk));
        emitReasoning(split.reasoning);
        if (split.content) {
          contentStreamed = true;
          input.eventBus.emit('agent.message.delta', { channel: 'answer', content: split.content }, { step: input.step });
        }
      }

      const flushed = thinkTags.flush();
      emitReasoning(flushed.reasoning);
      if (flushed.content) {
        contentStreamed = true;
        input.eventBus.emit('agent.message.delta', { channel: 'answer', content: flushed.content }, { step: input.step });
      }
    })(),
    input.timeoutMs,
    input.signal,
  );

  if (chunks.length === 0) {
    throw new Error('LLM stream completed without output');
  }

  const message = chunks.slice(1).reduce((combined, chunk) => combined.concat(chunk), chunks[0]);
  const calls = isAI(message) ? normalizeStreamToolCalls(message.tool_calls || []) : [];
  for (const call of calls) {
    const stream = [...toolStreams.values()].find((item) => item.callId === call.id || item.name === call.name)
    if (!call.id && stream?.callId) call.id = stream.callId
    if (call.id && !stream?.created) emitToolCreated(input, call.id, call.name)
    if (call.id && !stream?.ready) {
      input.eventBus.emit('tool.call.ready', { call_id: call.id, input: call.args || {} }, { step: input.step })
    }
  }
  return {
    contentStreamed,
    toolCalls: calls,
    message,
    reasoning,
    usage: messageTokenUsage(message),
  };
}

export class ChatCompletionsAdapter implements ModelAdapter {
  private readonly modelWithTools;

  constructor(settings: ChatModelSettings, runtimeTools: AgentToolSpec[]) {
    const model = createChatModel(settings);
    const tools = runtimeTools.map(createModelTool);
    this.modelWithTools = tools.length > 0 ? model.bindTools(tools) : model;
  }

  createInitialState(input: {
    context: AgentRunInput['context'];
    history: RuntimeMessage[];
    input: string;
    attachments: ResolvedImageAttachment[];
    runtimeTools: AgentToolSpec[];
  }): ModelConversationState {
    return {
      langchain: [
        createSystemMessage(input.runtimeTools),
        ...createRuntimeContextMessages([...(input.context.trustedContext || []), ...(input.context.contentManager?.buildInitialContext() || [])]),
        ...createHistoryMessages(input.history),
        createUserMessage(input.input, input.attachments),
      ],
    };
  }

  appendToolResult(state: ModelConversationState, input: {
    callId: string;
    name: string;
    output: unknown;
    images?: RuntimeToolImage[];
    status?: 'error' | 'success';
  }) {
    state.langchain?.push(
      new ToolMessage({
        content: JSON.stringify(input.output),
        tool_call_id: input.callId,
        name: input.name,
        status: input.status,
      }),
    );
    if (input.images?.length) {
      state.langchain?.push(new HumanMessage(input.images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: image.data_url },
      }))));
    }
  }

  appendContext(state: ModelConversationState, context: RuntimeContextItem[]) {
    state.langchain?.push(...createRuntimeContextMessages(context));
  }

  async streamStep(input: ModelStepInput): Promise<ModelStepResult> {
    if (!input.messages.langchain) throw new Error('Chat adapter state is missing');
    const stepResult = await streamChatModel({
      eventBus: input.eventBus,
      runtimeTools: input.runtimeTools,
      messages: input.messages.langchain,
      model: this.modelWithTools,
      showRawReasoning: input.showRawReasoning,
      step: input.step,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    const aiMessage = stepResult.message;
    input.messages.langchain.push(aiMessage);

    return {
      content: getMessageText(aiMessage),
      contentStreamed: stepResult.contentStreamed,
      message: aiMessage,
      reasoning: stepResult.reasoning,
      usage: stepResult.usage,
      toolCalls: stepResult.toolCalls,
    };
  }
}

export class ResponsesAdapter implements ModelAdapter {
  constructor(
    private readonly settings: ChatModelSettings,
    private readonly runtimeTools: AgentToolSpec[],
  ) {}

  createInitialState(input: {
    context: AgentRunInput['context'];
    history: RuntimeMessage[];
    input: string;
    attachments: ResolvedImageAttachment[];
    runtimeTools: AgentToolSpec[];
  }): ModelConversationState {
    return {
      responses: [
        {
          role: 'developer',
          content: createSystemPrompt(input.runtimeTools),
        },
        ...createResponsesContextItems([...(input.context.trustedContext || []), ...(input.context.contentManager?.buildInitialContext() || [])]),
        ...createResponsesHistoryMessages(input.history),
        {
          role: 'user',
          content: createResponsesUserContent(input.input, input.attachments),
        },
      ],
    };
  }

  appendToolResult(state: ModelConversationState, input: {
    callId: string;
    name: string;
    output: unknown;
    images?: RuntimeToolImage[];
    status?: 'error' | 'success';
  }) {
    state.responses?.push({
      type: 'function_call_output',
      call_id: input.callId,
      output: stringifyToolOutput(input.output),
    });
    if (input.images?.length) {
      state.responses?.push({
        role: 'user',
        content: input.images.map((image) => ({
          type: 'input_image',
          image_url: image.data_url,
        })),
      });
    }
  }

  appendContext(state: ModelConversationState, context: RuntimeContextItem[]) {
    state.responses?.push(...createResponsesContextItems(context));
  }

  async streamStep(input: ModelStepInput): Promise<ModelStepResult> {
    if (!input.messages.responses) throw new Error('Responses adapter state is missing');
    const outputItems: unknown[] = [];
    const textParts: string[] = [];
    let contentStreamed = false;
    const responseToolStates = new Map<string, { name: string; args: string; created: boolean; ready: boolean }>();
    const responseItemCallIds = new Map<string, string>();

    function updateResponseTool(item: Record<string, unknown>, argsDelta = '') {
      const itemId = typeof item.item_id === 'string' ? item.item_id : typeof item.id === 'string' ? item.id : ''
      const explicitCallId = typeof item.call_id === 'string' ? item.call_id : ''
      if (itemId && explicitCallId) responseItemCallIds.set(itemId, explicitCallId)
      const callId = explicitCallId || responseItemCallIds.get(itemId) || ''
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (!callId) return
      const state = responseToolStates.get(callId) || { name: '', args: '', created: false, ready: false }
      if (name) state.name = name
      if (argsDelta) state.args += argsDelta
      else if (typeof item.arguments === 'string') state.args = item.arguments
      if (!state.created && state.name) {
        emitToolCreated(input, callId, state.name)
        state.created = true
      }
      if (state.created && !state.ready) {
        const parsed = parseToolArguments(state.args) ?? (state.args === '' && typeof item.arguments === 'string' ? {} : undefined)
        if (parsed) {
          input.eventBus.emit('tool.call.ready', { call_id: callId, input: parsed }, { step: input.step })
          state.ready = true
        }
      }
      responseToolStates.set(callId, state)
    }

    await withTimeout(
      (async () => {
        const response = await fetch(resolveResponsesUrl(this.settings.apiBaseUrl), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.settings.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.settings.model,
            input: input.messages.responses,
            reasoning: createResponsesReasoning(this.settings),
            tools: createResponsesTools(this.runtimeTools),
            stream: true,
          }),
          signal: input.signal,
        });

        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }

        for await (const event of readSseEvents(response)) {
          throwIfAborted(input.signal);
          const data = event.data as Record<string, unknown>;

          if (event.event === 'response.output_text.delta' || event.event.endsWith('.output_text.delta')) {
            const delta = typeof data.delta === 'string' ? data.delta : collectTextValue(data.delta);
            if (delta) {
              textParts.push(delta);
              contentStreamed = true;
              input.eventBus.emit('agent.message.delta', { channel: 'answer', content: delta }, { step: input.step });
            }
            continue;
          }

          if (event.event === 'response.output_item.added' || event.event.endsWith('.output_item.added')) {
            const item = (data.item || data.output_item || data) as Record<string, unknown>
            if (item.type === 'function_call') updateResponseTool(item)
            continue
          }

          if (event.event === 'response.function_call_arguments.delta' || event.event.endsWith('.function_call_arguments.delta')) {
            const callId = typeof data.call_id === 'string' ? data.call_id : ''
            const itemId = typeof data.item_id === 'string' ? data.item_id : ''
            const delta = typeof data.delta === 'string' ? data.delta : ''
            if (callId || itemId) updateResponseTool({ ...(callId ? { call_id: callId } : {}), ...(itemId ? { item_id: itemId } : {}) }, delta)
            continue
          }

          if (event.event === 'response.output_item.done' || event.event.endsWith('.output_item.done')) {
            const item = (data.item || data.output_item || data) as Record<string, unknown>
            if (item.type === 'function_call') updateResponseTool(item)
            outputItems.push(item);
            continue;
          }

          if (event.event === 'response.completed' || event.event.endsWith('.completed')) {
            outputItems.push(data.response || data);
          }
        }
      })(),
      input.timeoutMs,
      input.signal,
    );

    const collected = collectResponseOutput(outputItems);
    const content = textParts.join('') || collected.content;
    const toolCalls = collected.toolCalls;

    if (content) {
      input.messages.responses.push({
        role: 'assistant',
        content,
      });
    }
    for (const call of toolCalls) {
      input.messages.responses.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args || {}),
      });
    }

    return {
      content,
      contentStreamed,
      message: outputItems,
      reasoning: '',
      toolCalls,
      usage: responsesTokenUsage(outputItems),
    };
  }
}

export function createModelAdapter(settings: ChatModelSettings, runtimeTools: AgentToolSpec[]): ModelAdapter {
  if (settings.type === 'openai-responses') return new ResponsesAdapter(settings, runtimeTools);
  return new ChatCompletionsAdapter(settings, runtimeTools);
}
