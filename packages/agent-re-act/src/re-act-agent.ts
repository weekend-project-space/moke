import { randomUUID } from 'node:crypto';

import type { AgentRunInput, AgentRunResult } from '@moke/agent-runtime';
import { normalizeRuntimeToolResult, ToolExecutionError } from '@moke/agent-runtime';
import type { AgentStep, AgentStepPhase, ModelSelection, TokenUsage, ToolCall } from '@moke/protocol';
import {
  ASK_USER_TOOL_NAME,
  askUserTool,
  createStepLimitContent,
  normalizeAskOptions,
  type AgentToolSpec,
} from './control-tools.js';
import { createFinalMessage, stripThinkBlocks } from './messages.js';
import { resolveChatModelSettings, type ChatModelSettings } from './llm-client.js';
import { createModelAdapter } from './model-adapter.js';

function normalizeLoopLimits(limits: AgentRunInput['limits']): AgentRunInput['limits'] {
  return {
    max_steps: Math.max(1, Math.min(Math.trunc(limits.max_steps || 1), 1000)),
    max_tool_calls: Math.max(0, Math.min(Math.trunc(limits.max_tool_calls ?? 0), 200)),
  };
}

function normalizeTimeoutMs(timeoutMs: number) {
  return Math.max(1000, Math.min(Math.trunc(timeoutMs || 15000), 3600000));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Run cancelled');
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

function createAgentStep(index: number, phase: AgentStepPhase): AgentStep {
  return {
    index,
    phase,
  };
}

function addTokenUsage(total: TokenUsage, usage?: TokenUsage) {
  if (!usage) return;
  for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'uncached_input_tokens'] as const) {
    if (usage[key] !== undefined) total[key] = (total[key] || 0) + usage[key];
  }
}

export class ReActAgent {
  constructor(
    private readonly config: {
      getModelSettings?: (selection?: ModelSelection) => Partial<ChatModelSettings>;
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
    const modelSettings = {
      ...resolveChatModelSettings(this.config.getModelSettings?.(context.run?.env.model)),
      ...(context.run?.env.reasoningEffort ? { reasoningEffort: context.run.env.reasoningEffort } : {}),
    };
    if (!modelSettings.apiKey) {
      throw new Error('OPENAI_API_KEY is not set; ReAct agent requires an LLM provider.');
    }

    const limits = normalizeLoopLimits(rawLimits);
    const timeoutMs = normalizeTimeoutMs(modelSettings.timeoutMs);
    const runtimeTools: AgentToolSpec[] = [askUserTool, ...toolRegistry.list()];
    const toolSpecs = new Map(runtimeTools.map((runtimeTool) => [runtimeTool.name, runtimeTool]));
    const modelAdapter = createModelAdapter(modelSettings, runtimeTools);
    const modelMessages = modelAdapter.createInitialState({
      context,
      history,
      input,
      attachments,
      runtimeTools,
    });
    let toolCalls = 0;
    let finalContent = '';
    let finalContentStreamed = false;
    let hasObservation = false;
    let finalReasoning = '';
    const usage: TokenUsage = {};

    eventBus.emit('agent.started', { input });
    eventBus.emit('agent.plan', {
      mode: 'react',
      planner: 'manual-model-loop',
      model: modelSettings.model,
      tools: runtimeTools.map((tool) => tool.name),
    });

    let currentStepIndex = 0;

    for (let step = 0; step < limits.max_steps; step++) {
      currentStepIndex = step + 1;
      const reasonStep = createAgentStep(currentStepIndex, 'reason');
      const actStep = createAgentStep(currentStepIndex, 'act');
      throwIfAborted(context.abortSignal);
      eventBus.emit('agent.state', { state: 'reason' }, { step: reasonStep });

      const stepResult = await modelAdapter.streamStep({
        eventBus,
        input,
        attachments,
        context,
        history,
        messages: modelMessages,
        runtimeTools,
        showRawReasoning: modelSettings.showRawReasoning,
        step: reasonStep,
        signal: context.abortSignal,
        timeoutMs,
      });
      throwIfAborted(context.abortSignal);

      const calls = stepResult.toolCalls;
      addTokenUsage(usage, stepResult.usage);
      if (calls.length === 0) {
        const content = stripThinkBlocks(stepResult.content);
        finalContent = content || "I'm a bit tired, I'll ask later";
        finalReasoning = stepResult.reasoning;
        finalContentStreamed = stepResult.contentStreamed;
        break;
      }

      const callEntries = calls.map((call) => ({
        call,
        callId: call.id || `call_${randomUUID().slice(0, 8)}`,
      }));
      const persistedToolCalls: ToolCall[] = callEntries
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
            content: stripThinkBlocks(stepResult.content),
            created_at: now(),
            ...(stepResult.reasoning.trim() ? { reasoning: stepResult.reasoning.trim() } : {}),
            tool_calls: persistedToolCalls,
          },
        }, { step: reasonStep });
      }

      eventBus.emit('agent.state', { state: 'act' }, { step: actStep });
      for (const { call, callId } of callEntries) {
        throwIfAborted(context.abortSignal);
        const isAskUserCall = call.name === ASK_USER_TOOL_NAME;
        if (!isAskUserCall && toolCalls >= limits.max_tool_calls) {
          throw new Error('Maximum tool calls exceeded');
        }

        if (!isAskUserCall) toolCalls++;
        const startedAt = Date.now();
        try {
          const rawOutput =
            isAskUserCall
              ? await this.askUser(call.args || {}, callId, context)
              : await toolRegistry.execute(call.name, call.args || {}, {
                  ...context,
                  currentToolCall: {
                    callId,
                    tool: call.name,
                    input: toToolCallArgs(call.args),
                  },
                });
          const { publicOutput, modelOutput, images, context: appendedContext } = normalizeRuntimeToolResult(rawOutput);
          throwIfAborted(context.abortSignal);
          hasObservation = true;
          const approvals = context.consumeApprovals?.(callId) || [];

          eventBus.emit('tool.call.completed', {
            call_id: callId,
            status: 'ok',
            duration_ms: Date.now() - startedAt,
            output: publicOutput,
          }, { step: actStep });
          eventBus.emit('agent.message.done', {
            message: {
              id: messageId(),
              role: 'tool',
              content: JSON.stringify(publicOutput),
              created_at: now(),
              tool_call_id: callId,
              name: call.name,
              status: 'success',
              ...(approvals.length ? { approvals } : {}),
            },
          }, { step: actStep });
          modelAdapter.appendToolResult(modelMessages, {
            callId,
            name: call.name,
            output: modelOutput,
            images,
          });
          modelAdapter.appendContext(modelMessages, appendedContext);
          for (const contextItem of appendedContext) {
            if (contextItem.scope !== 'session' || contextItem.authority !== 'user') continue;
            eventBus.emit('agent.message.done', {
              message: {
                id: messageId(),
                role: 'user',
                content: contextItem.content,
                created_at: now(),
                visibility: 'internal',
              },
            }, { step: actStep });
          }
        } catch (error) {
          throwIfAborted(context.abortSignal);
          const output = createToolErrorOutput(error, call.name);
          const approvals = context.consumeApprovals?.(callId) || [];
          eventBus.emit('tool.call.completed', {
            call_id: callId,
            status: 'error',
            duration_ms: Date.now() - startedAt,
            output,
          }, { step: actStep });
          eventBus.emit('agent.message.done', {
            message: {
              id: messageId(),
              role: 'tool',
              content: JSON.stringify(output),
              created_at: now(),
              tool_call_id: callId,
              name: call.name,
              status: 'error',
              ...(approvals.length ? { approvals } : {}),
            },
          }, { step: actStep });
          modelAdapter.appendToolResult(modelMessages, {
            callId,
            name: call.name,
            output,
            status: 'error',
          });
        }
      }

      if (finalContent) break;
    }

    if (!finalContent) {
      finalContent = createStepLimitContent(hasObservation);
    }

    const content = finalContent;
    const message = createFinalMessage(content, finalReasoning);
    const respondStep = createAgentStep(currentStepIndex + 1, 'respond');
    eventBus.emit('agent.state', { state: 'respond' }, { step: respondStep });
    if (!finalContentStreamed) eventBus.emit('agent.message.delta', { channel: 'answer', content }, { step: respondStep });
    eventBus.emit('agent.message.done', { message }, { step: respondStep });

    return {
      toolCalls,
      message,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    };
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
