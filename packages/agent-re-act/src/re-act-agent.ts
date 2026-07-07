import { randomUUID } from 'node:crypto';

import { AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from 'langchain';

import type { AgentRunInput, AgentRunResult } from '../../agent-runtime/src/index.js';
import { ToolExecutionError } from '../../agent-runtime/src/index.js';
import type { ToolCall } from '../../protocol/src/index.js';
import {
  ASK_USER_TOOL_NAME,
  FINISH_TOOL_NAME,
  askUserTool,
  createStepLimitContent,
  finishTool,
  isControlTool,
  normalizeAskOptions,
  readFinishContent,
  type AgentToolSpec,
} from './control-tools.js';
import {
  createFinalMessage,
  createHistoryMessages,
  createSystemMessage,
  createUserMessage,
  getMessageText,
  isAI,
} from './messages.js';
import {
  createChatModel,
  resolveChatModelSettings,
  withTimeout,
  type ChatModelSettings,
} from './llm-client.js';

function normalizeLimits(limits: AgentRunInput['limits']): AgentRunInput['limits'] {
  return {
    max_steps: Math.max(1, Math.min(Math.trunc(limits.max_steps || 1), 1000)),
    max_tool_calls: Math.max(0, Math.min(Math.trunc(limits.max_tool_calls ?? 0), 200)),
    timeout_ms: Math.max(1000, Math.min(Math.trunc(limits.timeout_ms || 15000), 3600000)),
  };
}

function normalizeTimeoutMs(timeoutMs: number) {
  return Math.max(1000, Math.min(Math.trunc(timeoutMs || 15000), 3600000));
}

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

function createToolErrorOutput(error: unknown, toolName: string) {
  if (error instanceof ToolExecutionError) return error.output;

  return {
    error: {
      code: 'TOOL_FAILED',
      message: error instanceof Error ? error.message : String(error),
      tool: toolName,
    },
  };
}

function now() {
  return new Date().toISOString();
}

function messageId() {
  return `msg_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function toToolCallArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

type StreamableChatModel = {
  stream(
    input: BaseMessage[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AIMessageChunk> | Promise<AsyncIterable<AIMessageChunk>>;
};

async function streamModelStep(input: {
  eventBus: AgentRunInput['eventBus'];
  messages: BaseMessage[];
  model: StreamableChatModel;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  const chunks: AIMessageChunk[] = [];

  await withTimeout(
    (async () => {
      const stream = await input.model.stream(input.messages, { signal: input.signal });

      for await (const chunk of stream) {
        throwIfAborted(input.signal);
        chunks.push(chunk);

        const content = getMessageText(chunk);
        if (content) input.eventBus.emit('agent.message.delta', { content });
      }
    })(),
    input.timeoutMs,
    input.signal,
  );

  if (chunks.length === 0) {
    throw new Error('LLM stream completed without output');
  }

  return chunks.slice(1).reduce((message, chunk) => message.concat(chunk), chunks[0]);
}

export class ReActAgent {
  constructor(
    private readonly config: {
      getModelSettings?: () => Partial<ChatModelSettings>;
    } = {},
  ) {}

  async run({
    input,
    attachments = [],
    history = [],
    eventBus,
    toolRegistry,
    context,
    limits: rawLimits,
  }: AgentRunInput): Promise<AgentRunResult> {
    const modelSettings = resolveChatModelSettings(this.config.getModelSettings?.());
    if (!modelSettings.apiKey) {
      throw new Error('OPENAI_API_KEY is not set; ReAct agent requires an LLM provider.');
    }

    const limits = normalizeLimits(rawLimits);
    const model = createChatModel(modelSettings);
    const timeoutMs = normalizeTimeoutMs(modelSettings.timeoutMs);
    const runtimeTools: AgentToolSpec[] = [finishTool, askUserTool, ...toolRegistry.list()];
    const toolSpecs = new Map(runtimeTools.map((runtimeTool) => [runtimeTool.name, runtimeTool]));
    const tools = runtimeTools.map(createModelTool);
    const modelWithTools = tools.length > 0 ? model.bindTools(tools) : model;
    const messages: BaseMessage[] = [
      createSystemMessage(runtimeTools, context),
      ...createHistoryMessages(history),
      createUserMessage(input, attachments),
    ];
    let toolCalls = 0;
    let finalContent = '';
    let finalContentStreamed = false;
    let hasObservation = false;

    eventBus.emit('agent.started', { input });
    eventBus.emit('agent.plan', {
      mode: 'react',
      planner: 'manual-model-loop',
      model: modelSettings.model,
      tools: runtimeTools.map((tool) => tool.name),
    });

    for (let step = 0; step < limits.max_steps; step++) {
      throwIfAborted(context.abortSignal);
      eventBus.emit('agent.state', { state: 'reason' });
      messages[0] = createSystemMessage(runtimeTools, context);

      const aiMessage = await streamModelStep({
        eventBus,
        messages,
        model: modelWithTools,
        signal: context.abortSignal,
        timeoutMs,
      });
      throwIfAborted(context.abortSignal);
      messages.push(aiMessage);

      const calls = isAI(aiMessage) ? aiMessage.tool_calls || [] : [];
      if (calls.length === 0) {
        const content = getMessageText(aiMessage).trim();
        finalContent = content || '我暂时没有更多可补充的信息。';
        finalContentStreamed = Boolean(content);
        break;
      }

      const callEntries = calls.map((call) => ({
        call,
        callId: call.id || `call_${randomUUID().slice(0, 8)}`,
      }));
      const persistedToolCalls: ToolCall[] = callEntries
        .filter(({ call }) => !isControlTool(call.name))
        .map(({ call, callId }) => ({
          id: callId,
          name: call.name,
          args: toToolCallArgs(call.args),
        }));
      if (persistedToolCalls.length > 0) {
        eventBus.emit('agent.message.done', {
          message: {
            id: messageId(),
            role: 'assistant',
            content: getMessageText(aiMessage).trim(),
            created_at: now(),
            tool_calls: persistedToolCalls,
          },
        });
      }

      eventBus.emit('agent.state', { state: 'act' });
      for (const { call, callId } of callEntries) {
        throwIfAborted(context.abortSignal);
        const isFinishCall = call.name === FINISH_TOOL_NAME;
        const isControlCall = isControlTool(call.name);
        if (!isControlCall && toolCalls >= limits.max_tool_calls) {
          throw new Error('Maximum tool calls exceeded');
        }

        if (!isControlCall) toolCalls++;
        const runtimeTool = toolSpecs.get(call.name);
        eventBus.emit('tool.call', {
          call_id: callId,
          tool: call.name,
          input: call.args || {},
          risk: runtimeTool?.risk || 'safe',
          source: runtimeTool?.source || { type: 'local' },
        });

        const startedAt = Date.now();
        try {
          if (isFinishCall) {
            finalContent = readFinishContent(call.args || {});
            const output = {
              status: 'finished',
              content: finalContent,
            };

            eventBus.emit('tool.result', {
              call_id: callId,
              status: 'ok',
              duration_ms: Date.now() - startedAt,
              output,
            });
            messages.push(
              new ToolMessage({
                content: JSON.stringify(output),
                tool_call_id: callId,
              }),
            );
            break;
          }

          const output =
            call.name === ASK_USER_TOOL_NAME
              ? await this.askUser(call.args || {}, callId, context)
              : await toolRegistry.execute(call.name, call.args || {}, {
                  ...context,
                  currentToolCall: {
                    callId,
                    tool: call.name,
                    input: toToolCallArgs(call.args),
                    risk: runtimeTool?.risk || 'safe',
                  },
                });
          throwIfAborted(context.abortSignal);
          hasObservation = true;

          eventBus.emit('tool.result', {
            call_id: callId,
            status: 'ok',
            duration_ms: Date.now() - startedAt,
            output,
          });
          if (!isControlCall) {
            eventBus.emit('agent.message.done', {
              message: {
                id: messageId(),
                role: 'tool',
                content: JSON.stringify(output),
                created_at: now(),
                tool_call_id: callId,
                name: call.name,
                status: 'success',
              },
            });
          }
          messages.push(
            new ToolMessage({
              content: JSON.stringify(output),
              tool_call_id: callId,
            }),
          );
        } catch (error) {
          throwIfAborted(context.abortSignal);
          const output = createToolErrorOutput(error, call.name);
          eventBus.emit('tool.result', {
            call_id: callId,
            status: 'error',
            duration_ms: Date.now() - startedAt,
            output,
          });
          if (!isControlCall) {
            eventBus.emit('agent.message.done', {
              message: {
                id: messageId(),
                role: 'tool',
                content: JSON.stringify(output),
                created_at: now(),
                tool_call_id: callId,
                name: call.name,
                status: 'error',
              },
            });
          }
          messages.push(
            new ToolMessage({
              content: JSON.stringify(output),
              tool_call_id: callId,
              status: 'error',
            }),
          );
        }
      }

      if (finalContent) break;
    }

    if (!finalContent) {
      finalContent = createStepLimitContent(hasObservation);
    }

    const content = finalContent;
    const message = createFinalMessage(content);
    eventBus.emit('agent.state', { state: 'respond' });
    if (!finalContentStreamed) eventBus.emit('agent.message.delta', { content });
    eventBus.emit('agent.message.done', { message });

    return { toolCalls, message };
  }

  private async askUser(input: Record<string, unknown>, callId: string, context: AgentRunInput['context']) {
    if (!context.askUser) {
      throw new Error('ask_user is not available in this runtime context');
    }

    const question = typeof input.question === 'string' && input.question.trim() ? input.question.trim() : '请选择下一步。';
    const options = normalizeAskOptions(input.options);
    const selected = await context.askUser({ callId, question, options });

    return {
      question,
      selected,
      status: 'answered',
    };
  }
}
