import { AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from 'langchain';

import type { AgentStep, ImageAttachment, Message, ToolCall } from '../../protocol/src/index.js';
import type { AgentRunInput } from '../../agent-runtime/src/index.js';
import type { AgentToolSpec } from './control-tools.js';
import {
  createHistoryMessages,
  createSystemMessage,
  createThinkTagSplitter,
  createUserMessage,
  getMessageText,
  getReasoningText,
  isAI,
} from './messages.js';
import { createChatModel, type ChatModelSettings, withTimeout } from './llm-client.js';

export type ModelStepInput = {
  eventBus: AgentRunInput['eventBus'];
  input: string;
  attachments: ImageAttachment[];
  context: AgentRunInput['context'];
  history: Message[];
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
};

export type ModelConversationState = {
  langchain?: BaseMessage[];
  responses?: ResponsesInputItem[];
};

export type ModelAdapter = {
  createInitialState(input: {
    context: AgentRunInput['context'];
    history: Message[];
    input: string;
    attachments: ImageAttachment[];
    runtimeTools: AgentToolSpec[];
  }): ModelConversationState;
  appendToolResult(state: ModelConversationState, input: {
    callId: string;
    name: string;
    output: unknown;
    status?: 'error' | 'success';
  }): void;
  streamStep(input: ModelStepInput): Promise<ModelStepResult>;
};

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

function toToolCallArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

type ResponseContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string };

type ResponsesInputItem =
  | { role: 'system' | 'user' | 'assistant'; content: string | ResponseContentItem[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type ResponsesFunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

type ResponsesStreamEvent = {
  event: string;
  data: unknown;
};

function resolveResponsesUrl(apiBaseUrl: string) {
  const base = apiBaseUrl.replace(/\/+$/, '');
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

function stringifyToolOutput(output: unknown) {
  return typeof output === 'string' ? output : JSON.stringify(output);
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

function createResponsesUserContent(content: string, attachments: ImageAttachment[]): ResponseContentItem[] {
  return [
    ...(content ? [{ type: 'input_text' as const, text: content }] : []),
    ...attachments.map((attachment) => ({
      type: 'input_image' as const,
      image_url: attachment.data_url,
    })),
  ];
}

function createResponsesHistoryMessages(history: Message[]): ResponsesInputItem[] {
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

function parseJsonRecord(input: string): Record<string, unknown> {
  try {
    const value = JSON.parse(input);
    return toToolCallArgs(value);
  } catch {
    return {};
  }
}

function collectTextValue(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectTextValue).filter(Boolean).join('');
  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  return collectTextValue(record.text) || collectTextValue(record.content) || collectTextValue(record.delta);
}

function collectResponseOutput(input: unknown) {
  const toolCalls: ToolCall[] = [];
  const seenToolCalls = new Set<string>();
  const text: string[] = [];

  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, unknown>;
    if (record.type === 'function_call' || record.type === 'function_call_output') {
      const callId = typeof record.call_id === 'string' ? record.call_id : typeof record.id === 'string' ? record.id : '';
      const name = typeof record.name === 'string' ? record.name : '';
      const rawArgs = typeof record.arguments === 'string' ? record.arguments : '{}';
      const key = `${callId}:${name}:${rawArgs}`;
      if (record.type === 'function_call' && name && !seenToolCalls.has(key)) {
        seenToolCalls.add(key);
        toolCalls.push({
          id: callId,
          name,
          args: parseJsonRecord(rawArgs),
        });
      }
    }

    if (record.type === 'output_text' || record.type === 'text') {
      const valueText = collectTextValue(record);
      if (valueText) text.push(valueText);
    }

    visit(record.content);
    visit(record.output);
  }

  visit(input);
  return {
    content: text.join(''),
    toolCalls,
  };
}

async function* readSseEvents(response: Response): AsyncGenerator<ResponsesStreamEvent> {
  if (!response.body) return;

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  function parseBlock(block: string): ResponsesStreamEvent | undefined {
    let event = 'message';
    const data: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }

    const rawData = data.join('\n');
    if (!rawData || rawData === '[DONE]') return undefined;

    try {
      return { event, data: JSON.parse(rawData) };
    } catch {
      return { event, data: rawData };
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.search(/\r?\n\r?\n/);
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        const separator = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
        buffer = buffer.slice(separatorIndex + separator.length);
        const event = parseBlock(block);
        if (event) yield event;
        separatorIndex = buffer.search(/\r?\n\r?\n/);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
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

  return {
    contentStreamed,
    message: chunks.slice(1).reduce((message, chunk) => message.concat(chunk), chunks[0]),
    reasoning,
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
    history: Message[];
    input: string;
    attachments: ImageAttachment[];
    runtimeTools: AgentToolSpec[];
  }): ModelConversationState {
    return {
      langchain: [
        createSystemMessage(input.runtimeTools, input.context),
        ...createHistoryMessages(input.history),
        createUserMessage(input.input, input.attachments),
      ],
    };
  }

  appendToolResult(state: ModelConversationState, input: {
    callId: string;
    name: string;
    output: unknown;
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
  }

  async streamStep(input: ModelStepInput): Promise<ModelStepResult> {
    if (!input.messages.langchain) throw new Error('Chat adapter state is missing');
    input.messages.langchain[0] = createSystemMessage(input.runtimeTools, input.context);

    const stepResult = await streamChatModel({
      eventBus: input.eventBus,
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
      toolCalls: isAI(aiMessage)
        ? (aiMessage.tool_calls || []).map((call) => ({
            id: call.id || '',
            name: call.name,
            args: toToolCallArgs(call.args),
          }))
        : [],
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
    history: Message[];
    input: string;
    attachments: ImageAttachment[];
    runtimeTools: AgentToolSpec[];
  }): ModelConversationState {
    const system = createSystemMessage(input.runtimeTools, input.context);
    return {
      responses: [
        {
          role: 'system',
          content: getMessageText(system),
        },
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
    status?: 'error' | 'success';
  }) {
    state.responses?.push({
      type: 'function_call_output',
      call_id: input.callId,
      output: stringifyToolOutput(input.output),
    });
  }

  async streamStep(input: ModelStepInput): Promise<ModelStepResult> {
    if (!input.messages.responses) throw new Error('Responses adapter state is missing');
    input.messages.responses[0] = {
      role: 'system',
      content: getMessageText(createSystemMessage(input.runtimeTools, input.context)),
    };

    const outputItems: unknown[] = [];
    const textParts: string[] = [];
    let contentStreamed = false;

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

          if (event.event === 'response.output_item.done' || event.event.endsWith('.output_item.done')) {
            outputItems.push(data.item || data.output_item || data);
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
    };
  }
}

export function createModelAdapter(settings: ChatModelSettings, runtimeTools: AgentToolSpec[]): ModelAdapter {
  if (settings.type === 'openai-responses') return new ResponsesAdapter(settings, runtimeTools);
  return new ChatCompletionsAdapter(settings, runtimeTools);
}
