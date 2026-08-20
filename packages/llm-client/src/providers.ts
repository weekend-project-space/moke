import { readSse } from './sse.js';
import {
  LlmClientError,
  type ChatInputItem,
  type ChatOutputItem,
  type ChatRequest,
  type FinishReason,
  type LlmClientOptions,
  type TokenUsage,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
} from './types.js';

export type ProviderEvent = {
  type:
    | 'started'
    | 'text.delta'
    | 'text.completed'
    | 'thinking.delta'
    | 'thinking.completed'
    | 'tool_call.delta'
    | 'tool_call.completed'
    | 'usage'
    | 'raw'
    | 'completed';
  payload: unknown;
  responseId?: string;
  itemId?: string;
  eventType?: string;
};

export type ResolvedRequest = ChatRequest & {
  model: string;
  timeoutMs: number;
  store?: boolean;
};

type ProviderContext = {
  signal: AbortSignal;
  fetch: typeof fetch;
};

type CompletedPayload = {
  id: string;
  model: string;
  text: string;
  output: ChatOutputItem[];
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  finishReason?: FinishReason;
  providerRequestId?: string;
  rawResponse?: unknown;
};

export interface ProviderAdapter {
  readonly name: string;
  stream(request: ResolvedRequest, context: ProviderContext): AsyncIterable<ProviderEvent>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function json(value: unknown) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

function parseArguments(value: string, provider: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new LlmClientError('Tool call arguments are not valid JSON', {
      kind: 'protocol',
      provider,
      details: value,
      cause,
    });
  }
  throw new LlmClientError('Tool call arguments must be a JSON object', {
    kind: 'protocol',
    provider,
    details: value,
  });
}

function mapFinishReason(value: unknown): FinishReason | undefined {
  if (value === 'stop' || value === 'length' || value === 'tool_calls' || value === 'content_filter') return value;
  return value ? 'unknown' : undefined;
}

function responsesUsage(value: unknown): TokenUsage | undefined {
  const usage = record(value);
  if (Object.keys(usage).length === 0) return undefined;
  const inputDetails = record(usage.input_tokens_details);
  const outputDetails = record(usage.output_tokens_details);
  return {
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    totalTokens: number(usage.total_tokens),
    ...(number(outputDetails.reasoning_tokens) ? { reasoningTokens: number(outputDetails.reasoning_tokens) } : {}),
    ...(number(inputDetails.cached_tokens) ? { cachedTokens: number(inputDetails.cached_tokens) } : {}),
  };
}

function chatUsage(value: unknown): TokenUsage | undefined {
  const usage = record(value);
  if (Object.keys(usage).length === 0) return undefined;
  const promptDetails = record(usage.prompt_tokens_details);
  const completionDetails = record(usage.completion_tokens_details);
  return {
    inputTokens: number(usage.prompt_tokens),
    outputTokens: number(usage.completion_tokens),
    totalTokens: number(usage.total_tokens),
    ...(number(completionDetails.reasoning_tokens) ? { reasoningTokens: number(completionDetails.reasoning_tokens) } : {}),
    ...(number(promptDetails.cached_tokens) ? { cachedTokens: number(promptDetails.cached_tokens) } : {}),
  };
}

function endpoint(baseUrl: string, path: string) {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith(path) ? normalized : `${normalized}${path}`;
}

async function requestStream(
  options: LlmClientOptions,
  context: ProviderContext,
  url: string,
  body: unknown,
) {
  let response: Response;
  try {
    response = await context.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...options.headers,
      },
      body: JSON.stringify(body),
      signal: context.signal,
    });
  } catch (cause) {
    if (context.signal.aborted) throw cause;
    throw new LlmClientError('Failed to connect to the model provider', {
      kind: 'transport',
      provider: options.provider,
      retryable: true,
      cause,
    });
  }

  if (!response.ok) throw await httpError(response, options.provider);
  return response;
}

async function httpError(response: Response, provider: string) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = await response.text().catch(() => undefined);
  }
  const error = record(record(payload).error);
  const message = string(error.message) || string(record(payload).message) || `Provider returned HTTP ${response.status}`;
  const kind = response.status === 401
    ? 'authentication'
    : response.status === 403
      ? 'authorization'
      : response.status === 429
        ? 'rate_limit'
        : response.status >= 400 && response.status < 500
          ? 'invalid_request'
          : 'provider';
  const retryAfter = Number(response.headers.get('retry-after'));
  return new LlmClientError(message, {
    kind,
    provider,
    retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    statusCode: response.status,
    providerCode: string(error.code) || undefined,
    providerRequestId: response.headers.get('x-request-id') || undefined,
    retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    details: payload,
  });
}

function mapResponsesInput(input: string | ChatInputItem[]) {
  if (typeof input === 'string') return input;
  return input.map((item) => {
    if (item.type === 'message') {
      return {
        role: item.role,
        content: typeof item.content === 'string'
          ? item.content
          : item.content.map((part) => {
              if (part.type === 'text') return { type: item.role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
              if (part.type === 'image') return { type: 'input_image', image_url: part.url, detail: part.detail };
              return { type: 'input_file', file_id: part.fileId };
            }),
      };
    }
    if (item.type === 'tool_call') {
      return { type: 'function_call', call_id: item.callId, name: item.name, arguments: json(item.arguments) };
    }
    return { type: 'function_call_output', call_id: item.callId, output: json(item.output) };
  });
}

function responsesTools(tools: ToolDefinition[] | undefined) {
  return tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict,
  }));
}

function responsesToolChoice(choice: ToolChoice | undefined) {
  if (!choice || typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}

function collectResponsesOutput(response: Record<string, unknown>, provider: string) {
  const output: ChatOutputItem[] = [];
  const toolCalls: ToolCall[] = [];
  let text = '';
  for (const rawItem of Array.isArray(response.output) ? response.output : []) {
    const item = record(rawItem);
    if (item.type === 'function_call') {
      const argumentsJson = string(item.arguments) || '{}';
      const toolCall = {
        callId: string(item.call_id) || string(item.id),
        name: string(item.name),
        argumentsJson,
        arguments: parseArguments(argumentsJson, provider),
      };
      toolCalls.push(toolCall);
      output.push({ type: 'tool_call', toolCall });
      continue;
    }
    if (item.type === 'message') {
      for (const rawPart of Array.isArray(item.content) ? item.content : []) {
        const part = record(rawPart);
        if (part.type === 'output_text') {
          const value = string(part.text);
          text += value;
          output.push({ type: 'text', text: value });
        } else if (part.type === 'refusal') {
          output.push({ type: 'refusal', text: string(part.refusal) || string(part.text) });
        } else {
          output.push({ type: 'unknown', raw: rawPart });
        }
      }
    }
  }
  return { text, output, toolCalls };
}

export class OpenAiResponsesAdapter implements ProviderAdapter {
  readonly name = 'openai-responses';

  constructor(private readonly options: LlmClientOptions) {}

  async *stream(request: ResolvedRequest, context: ProviderContext): AsyncIterable<ProviderEvent> {
    const body = {
      ...request.providerOptions,
      model: request.model,
      input: mapResponsesInput(request.input),
      instructions: request.instructions,
      tools: responsesTools(request.tools),
      tool_choice: responsesToolChoice(request.toolChoice),
      parallel_tool_calls: request.parallelToolCalls,
      reasoning: request.reasoning,
      max_output_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      top_p: request.topP,
      previous_response_id: request.previousResponseId,
      store: request.store,
      metadata: request.metadata,
      stream: true,
    };
    const response = await requestStream(
      this.options,
      context,
      endpoint(this.options.baseUrl || 'https://api.openai.com/v1', '/responses'),
      body,
    );
    const requestId = response.headers.get('x-request-id') || undefined;
    const emittedTools = new Set<string>();
    const toolStates = new Map<string, { callId: string; name: string; arguments: string }>();
    let started = false;
    let responseId = '';
    let text = '';
    let thinking = '';

    for await (const sse of readSse(response)) {
      if (sse.event === 'done') continue;
      const data = record(sse.data);
      const type = string(data.type) || sse.event;
      const responseValue = record(data.response);

      if (type === 'response.created') {
        responseId = string(responseValue.id);
        started = true;
        yield { type: 'started', payload: { responseId }, responseId, eventType: type };
        continue;
      }
      if (!started) {
        started = true;
        responseId = string(responseValue.id) || string(data.response_id);
        yield { type: 'started', payload: { responseId: responseId || undefined }, responseId: responseId || undefined, eventType: type };
      }
      if (type === 'response.output_text.delta') {
        const delta = string(data.delta);
        text += delta;
        if (delta) yield { type: 'text.delta', payload: { delta }, responseId, itemId: string(data.item_id), eventType: type };
        continue;
      }
      if (type === 'response.output_text.done') {
        yield { type: 'text.completed', payload: { text: string(data.text) || text }, responseId, itemId: string(data.item_id), eventType: type };
        continue;
      }
      if (type === 'response.reasoning_summary_text.delta') {
        const delta = string(data.delta);
        thinking += delta;
        if (delta) yield { type: 'thinking.delta', payload: { delta, visibility: 'summary' }, responseId, itemId: string(data.item_id), eventType: type };
        continue;
      }
      if (type === 'response.reasoning_summary_text.done') {
        yield { type: 'thinking.completed', payload: { text: string(data.text) || thinking, visibility: 'summary' }, responseId, itemId: string(data.item_id), eventType: type };
        continue;
      }
      if (type === 'response.output_item.added') {
        const item = record(data.item);
        if (item.type === 'function_call') {
          const key = string(item.id) || string(item.call_id);
          toolStates.set(key, { callId: string(item.call_id), name: string(item.name), arguments: string(item.arguments) });
        }
        continue;
      }
      if (type === 'response.function_call_arguments.delta') {
        const key = string(data.item_id) || string(data.call_id);
        const current = toolStates.get(key) || { callId: string(data.call_id), name: string(data.name), arguments: '' };
        const delta = string(data.delta);
        current.callId ||= string(data.call_id);
        current.name ||= string(data.name);
        current.arguments += delta;
        toolStates.set(key, current);
        yield { type: 'tool_call.delta', payload: { callId: current.callId || key, name: current.name || undefined, argumentsDelta: delta }, responseId, itemId: key, eventType: type };
        continue;
      }
      if (type === 'response.output_item.done') {
        const item = record(data.item);
        if (item.type === 'function_call') {
          const key = string(item.id) || string(item.call_id);
          const current = toolStates.get(key);
          const callId = string(item.call_id) || current?.callId || key;
          if (!emittedTools.has(callId)) {
            const argumentsJson = string(item.arguments) || current?.arguments || '{}';
            const toolCall = { callId, name: string(item.name) || current?.name || '', argumentsJson, arguments: parseArguments(argumentsJson, this.name) };
            emittedTools.add(callId);
            yield { type: 'tool_call.completed', payload: toolCall, responseId, itemId: key, eventType: type };
          }
        }
        continue;
      }
      if (type === 'response.completed') {
        const finalResponse = responseValue;
        responseId = string(finalResponse.id) || responseId;
        const collected = collectResponsesOutput(finalResponse, this.name);
        const usage = responsesUsage(finalResponse.usage);
        if (usage) yield { type: 'usage', payload: usage, responseId, eventType: type };
        yield {
          type: 'completed',
          responseId,
          eventType: type,
          payload: {
            id: responseId,
            model: string(finalResponse.model) || request.model,
            text: collected.text || text,
            output: collected.output.length ? collected.output : text ? [{ type: 'text', text }] : [],
            toolCalls: collected.toolCalls,
            usage,
            finishReason: 'stop',
            providerRequestId: requestId,
            rawResponse: finalResponse,
          } satisfies CompletedPayload,
        };
        return;
      }
      if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
        const error = record(data.error || responseValue.error);
        throw new LlmClientError(string(error.message) || `Responses stream ended with ${type}`, {
          kind: type === 'response.incomplete' ? 'provider' : 'provider',
          provider: this.name,
          providerCode: string(error.code) || undefined,
          providerRequestId: requestId,
          details: data,
        });
      }
      if (type === 'response.in_progress' || type === 'response.content_part.added' || type === 'response.content_part.done') continue;
      yield { type: 'raw', payload: { provider: this.name, type, raw: sse.data }, responseId, eventType: type };
    }

    throw new LlmClientError('Responses stream ended without response.completed', {
      kind: 'protocol',
      provider: this.name,
      providerRequestId: requestId,
    });
  }
}

function mapChatContent(content: string | import('./types.js').InputContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image_url', image_url: { url: part.url, detail: part.detail } };
    throw new LlmClientError('Chat Completions does not support fileId input through this client', { kind: 'unsupported_feature' });
  });
}

function mapChatMessages(request: ResolvedRequest, supportsDeveloperRole: boolean) {
  const items = typeof request.input === 'string'
    ? [{ type: 'message' as const, role: 'user' as const, content: request.input }]
    : request.input;
  const messages: Record<string, unknown>[] = [];
  const systemContents: unknown[] = [];
  if (request.instructions) {
    if (supportsDeveloperRole) messages.push({ role: 'developer', content: request.instructions });
    else systemContents.push(request.instructions);
  }
  for (const item of items) {
    if (item.type === 'message') {
      const role = item.role === 'developer' && !supportsDeveloperRole ? 'system' : item.role;
      const content = mapChatContent(item.content);
      if (role === 'system') systemContents.push(content);
      else messages.push({ role, content });
    } else if (item.type === 'tool_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: item.callId, type: 'function', function: { name: item.name, arguments: json(item.arguments) } }],
      });
    } else {
      messages.push({ role: 'tool', tool_call_id: item.callId, content: json(item.output) });
    }
  }
  if (systemContents.length) {
    const content = systemContents.every(item => typeof item === 'string')
      ? systemContents.join('\n\n')
      : systemContents.flatMap(item => Array.isArray(item) ? item : [{ type: 'text', text: String(item) }]);
    messages.unshift({ role: 'system', content });
  }
  return messages;
}

function chatTools(tools: ToolDefinition[] | undefined) {
  return tools?.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict } }));
}

function chatToolChoice(choice: ToolChoice | undefined) {
  if (!choice || typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

export class OpenAiChatCompletionsAdapter implements ProviderAdapter {
  readonly name: string;

  constructor(private readonly options: LlmClientOptions) {
    this.name = options.provider;
  }

  async *stream(request: ResolvedRequest, context: ProviderContext): AsyncIterable<ProviderEvent> {
    if (request.previousResponseId) {
      throw new LlmClientError('previousResponseId is only supported by the Responses API', {
        kind: 'unsupported_feature',
        provider: this.name,
      });
    }
    const compatible = this.options.compatible;
    const official = this.options.provider === 'openai-chat-completions';
    const includeUsage = official || compatible?.supportsStreamUsage !== false;
    const body = {
      ...request.providerOptions,
      model: request.model,
      messages: mapChatMessages(request, official || compatible?.supportsDeveloperRole !== false),
      tools: chatTools(request.tools),
      tool_choice: chatToolChoice(request.toolChoice),
      parallel_tool_calls: official || compatible?.supportsParallelToolCalls !== false ? request.parallelToolCalls : undefined,
      reasoning_effort: request.reasoning?.effort,
      max_completion_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      top_p: request.topP,
      store: request.store,
      metadata: request.metadata,
      n: 1,
      stream: true,
      stream_options: includeUsage ? { include_usage: true } : undefined,
    };
    const path = compatible?.endpoint || '/chat/completions';
    const response = await requestStream(
      this.options,
      context,
      endpoint(this.options.baseUrl || 'https://api.openai.com/v1', path),
      body,
    );
    const requestId = response.headers.get('x-request-id') || undefined;
    const toolStates = new Map<number, { callId: string; name: string; arguments: string; emitted: boolean }>();
    let responseId = '';
    let model = request.model;
    let text = '';
    let thinking = '';
    let refusal = '';
    let usage: TokenUsage | undefined;
    let finishReason: FinishReason | undefined;
    let started = false;
    let lastChunk: unknown;

    for await (const sse of readSse(response)) {
      if (sse.event === 'done') {
        if (!finishReason) {
          throw new LlmClientError('Chat Completions stream ended without finish_reason', { kind: 'protocol', provider: this.name });
        }
        const toolCalls = [...toolStates.values()].map(({ emitted: _, ...tool }) => ({
          callId: tool.callId,
          name: tool.name,
          argumentsJson: tool.arguments,
          arguments: parseArguments(tool.arguments, this.name),
        }));
        const output: ChatOutputItem[] = [];
        if (text) output.push({ type: 'text', text });
        if (thinking) output.push({ type: 'thinking', text: thinking, visibility: 'provider_exposed' });
        if (refusal) output.push({ type: 'refusal', text: refusal });
        output.push(...toolCalls.map((toolCall) => ({ type: 'tool_call' as const, toolCall })));
        yield {
          type: 'completed',
          responseId,
          eventType: 'done',
          payload: { id: responseId, model, text, output, toolCalls, usage, finishReason, providerRequestId: requestId, rawResponse: lastChunk } satisfies CompletedPayload,
        };
        return;
      }
      const chunk = record(sse.data);
      lastChunk = sse.data;
      if (chunk.object && chunk.object !== 'chat.completion.chunk') {
        yield { type: 'raw', payload: { provider: this.name, type: string(chunk.object), raw: sse.data }, eventType: string(chunk.object) };
        continue;
      }
      responseId ||= string(chunk.id);
      model = string(chunk.model) || model;
      if (!started) {
        started = true;
        yield { type: 'started', payload: { responseId }, responseId, eventType: 'chat.completion.chunk' };
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      if (choices.length > 1 || choices.some((value) => number(record(value).index) !== 0)) {
        throw new LlmClientError('Multiple Chat Completions choices are not supported', { kind: 'protocol', provider: this.name, details: chunk.choices });
      }
      if (choices.length === 0) {
        const nextUsage = chatUsage(chunk.usage);
        if (nextUsage) {
          usage = nextUsage;
          yield { type: 'usage', payload: usage, responseId, eventType: 'chat.completion.chunk' };
          continue;
        }
      }
      for (const rawChoice of choices) {
        const choice = record(rawChoice);
        const delta = record(choice.delta);
        const content = string(delta.content);
        if (content) {
          text += content;
          yield { type: 'text.delta', payload: { delta: content }, responseId, eventType: 'chat.completion.chunk' };
        }
        const refusalDelta = string(delta.refusal);
        if (refusalDelta) {
          refusal += refusalDelta;
          yield {
            type: 'raw',
            payload: { provider: this.name, type: 'chat.completion.refusal.delta', raw: { delta: refusalDelta } },
            responseId,
            eventType: 'chat.completion.chunk',
          };
        }
        const reasoning = string(delta.reasoning_content);
        if (reasoning && compatible?.reasoningFormat === 'reasoning_content') {
          thinking += reasoning;
          yield { type: 'thinking.delta', payload: { delta: reasoning, visibility: 'provider_exposed' }, responseId, eventType: 'chat.completion.chunk' };
        }
        for (const rawTool of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const tool = record(rawTool);
          const index = number(tool.index);
          const fn = record(tool.function);
          const current = toolStates.get(index) || { callId: '', name: '', arguments: '', emitted: false };
          current.callId ||= string(tool.id);
          current.name += string(fn.name);
          const argumentsDelta = string(fn.arguments);
          current.arguments += argumentsDelta;
          toolStates.set(index, current);
          if (argumentsDelta || tool.id || fn.name) {
            yield { type: 'tool_call.delta', payload: { callId: current.callId || `tool_${index}`, name: current.name || undefined, argumentsDelta }, responseId, eventType: 'chat.completion.chunk' };
          }
        }
        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason) || 'unknown';
          if (text) yield { type: 'text.completed', payload: { text }, responseId, eventType: 'chat.completion.chunk' };
          if (thinking) yield { type: 'thinking.completed', payload: { text: thinking, visibility: 'provider_exposed' }, responseId, eventType: 'chat.completion.chunk' };
          if (finishReason === 'tool_calls') {
            for (const state of toolStates.values()) {
              if (state.emitted) continue;
              const toolCall = { callId: state.callId, name: state.name, argumentsJson: state.arguments, arguments: parseArguments(state.arguments, this.name) };
              state.emitted = true;
              yield { type: 'tool_call.completed', payload: toolCall, responseId, eventType: 'chat.completion.chunk' };
            }
          }
        }
      }
    }

    throw new LlmClientError('Chat Completions stream ended without [DONE]', {
      kind: 'protocol',
      provider: this.name,
      providerRequestId: requestId,
    });
  }
}

export function createProvider(options: LlmClientOptions): ProviderAdapter {
  if (options.provider === 'openai-responses') return new OpenAiResponsesAdapter(options);
  return new OpenAiChatCompletionsAdapter(options);
}
