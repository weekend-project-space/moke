import { randomUUID } from 'node:crypto';

import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from 'langchain';
import { z } from 'zod';

import type { Message, RuntimeLimits } from '../../protocol/src/index.js';
import type { EventBus } from './event-bus.js';
import { createChatModel, withTimeout } from './llm-client.js';
import type { ToolContext } from './tool-context.js';
import { ToolExecutionError, type ToolRegistry } from './tool-registry.js';

type AgentRunInput = {
  input: string;
  history?: Message[];
  eventBus: EventBus;
  toolRegistry: ToolRegistry;
  context: ToolContext;
  limits: RuntimeLimits;
};

type AgentRunResult = {
  toolCalls: number;
  message: Message;
};

const FINISH_TOOL_NAME = 'finish';
const ASK_USER_TOOL_NAME = 'ask_user';
const finishSchema = z.object({
  content: z.string().min(1),
});
const askUserSchema = z.object({
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        label: z.string().min(1),
      }),
    )
    .min(2)
    .max(5),
});

type RuntimeToolSpec = ReturnType<ToolRegistry['list']>[number];
type AgentToolSpec = RuntimeToolSpec & {
  control?: true;
};

const finishTool: AgentToolSpec = {
  name: FINISH_TOOL_NAME,
  description: 'Finish the current agent run with the final answer. Call this when you have enough information to respond.',
  risk: 'safe',
  schema: finishSchema,
  control: true,
};

const askUserTool: AgentToolSpec = {
  name: ASK_USER_TOOL_NAME,
  description: 'Pause the current run to ask the user one question with 2 to 5 concrete options.',
  risk: 'safe',
  schema: askUserSchema,
  control: true,
};

function createSystemPrompt(customTools: AgentToolSpec[]) {
  const customToolList = customTools.map((tool) => `${tool.name}: ${tool.description}`).join('\n');
  const skillGuidance = customTools.some((tool) => tool.name === 'list_skills' || tool.name === 'read_skill')
    ? `
Skills:
- For code review, implementation planning, frontend design, MCP work, or other specialized tasks, call list_skills before inspecting files.
- If list_skills returns a relevant skill, call read_skill to activate it before continuing with specialized work.
- Do not read skills for greetings, small talk, or simple direct answers.`
    : '';

  return `You are Moke, a local-first ReAct agent.

You may answer directly when no tool is needed.
If you have used any tool observation in this run, only calling finish ends the current run.
Do not call project tools for greetings, small talk, or self-introduction; answer directly.
Use tools only when the user asks about project files, code, docs, or local context.
Do not include hidden reasoning, chain-of-thought, or <think> blocks.

Available tools:
${customToolList || 'None'}
${skillGuidance}

Guidelines:
- Prefer Chinese when the user writes Chinese.
- For repository search, use short file or repository keywords: README, docs, requirements, agent, server, client, runtime, package, tauri, vue.
- Use ask_user only when you cannot continue without a user decision; ask one concise question and provide 2 to 5 short options.
- After receiving observations, call finish when you have enough information.
- Never invent file contents you did not observe.`;
}

function createSystemMessage(runtimeTools: AgentToolSpec[], context: ToolContext) {
  const basePrompt = createSystemPrompt(runtimeTools);
  const extraContext = context.contentManager?.buildContext();
  if (!extraContext) return new SystemMessage(basePrompt);

  return new SystemMessage(`${basePrompt}\n\n${extraContext}`);
}

function createFinalMessage(content: string): Message {
  return {
    id: `msg_${Date.now()}`,
    role: 'assistant',
    content,
    created_at: new Date().toISOString(),
  };
}

function createHistoryMessages(history: Message[]) {
  return history.map((message) =>
    message.role === 'assistant' ? new AIMessage(message.content) : new HumanMessage(message.content),
  );
}

function getMessageText(message: BaseMessage) {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((item) => ('text' in item ? item.text : '')).join('\n');
}

function isAI(message: BaseMessage): message is AIMessage {
  return AIMessage.isInstance(message);
}

function createFinishReminder(aiMessage: BaseMessage) {
  const content = getMessageText(aiMessage).trim();
  const answer = content ? ` Use this answer as finish.content if it is already complete: ${JSON.stringify(content)}` : '';
  return new SystemMessage(`You must call the ${FINISH_TOOL_NAME} tool to end this run.${answer}`);
}

function readFinishContent(input: unknown) {
  const result = finishSchema.safeParse(input);
  if (result.success) return result.data.content.trim();

  throw new ToolExecutionError('Finish input invalid', {
    error: {
      code: 'FINISH_INPUT_INVALID',
      message: z.prettifyError(result.error),
      tool: FINISH_TOOL_NAME,
    },
  });
}

function isControlTool(name: string) {
  return name === FINISH_TOOL_NAME || name === ASK_USER_TOOL_NAME;
}

export class ReactAgent {
  async run({ input, history = [], eventBus, toolRegistry, context, limits }: AgentRunInput): Promise<AgentRunResult> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set; ReAct agent requires an LLM provider.');
    }

    const model = createChatModel();
    const timeoutMs = limits.timeout_ms || Number(process.env.OPENAI_TIMEOUT_MS || 15000);
    const runtimeTools: AgentToolSpec[] = [finishTool, askUserTool, ...toolRegistry.list()];
    const toolSpecs = new Map(runtimeTools.map((runtimeTool) => [runtimeTool.name, runtimeTool]));
    const tools = runtimeTools.map((runtimeTool) =>
      tool(
        async (toolInput) => {
          if (runtimeTool.name === FINISH_TOOL_NAME) {
            return JSON.stringify({ status: 'finished', content: readFinishContent(toolInput) });
          }
          if (runtimeTool.name === ASK_USER_TOOL_NAME) {
            return JSON.stringify({ status: 'awaiting_user' });
          }

          const output = await toolRegistry.execute(runtimeTool.name, toolInput, context);
          return JSON.stringify(output);
        },
        {
          name: runtimeTool.name,
          description: runtimeTool.description,
          schema: runtimeTool.schema,
        },
      ),
    );
    const modelWithTools = tools.length > 0 ? model.bindTools(tools) : model;
    const messages: BaseMessage[] = [
      createSystemMessage(runtimeTools, context),
      ...createHistoryMessages(history),
      new HumanMessage(input),
    ];
    let toolCalls = 0;
    let finalContent = '';
    let hasObservation = false;

    eventBus.emit('agent.started', { input });
    eventBus.emit('agent.plan', {
      mode: 'react',
      planner: 'manual-model-loop',
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      tools: runtimeTools.map((tool) => tool.name),
    });

    for (let step = 0; step < limits.max_steps; step++) {
      eventBus.emit('agent.state', { state: 'reason' });
      messages[0] = createSystemMessage(runtimeTools, context);

      const aiMessage = await withTimeout(modelWithTools.invoke(messages), timeoutMs);
      messages.push(aiMessage);

      const calls = isAI(aiMessage) ? aiMessage.tool_calls || [] : [];
      if (calls.length === 0) {
        const content = getMessageText(aiMessage).trim();
        if (!hasObservation) {
          finalContent = content || '我暂时没有更多可补充的信息。';
          break;
        }

        messages.push(createFinishReminder(aiMessage));
        continue;
      }

      eventBus.emit('agent.state', { state: 'act' });
      for (const call of calls) {
        const isFinishCall = call.name === FINISH_TOOL_NAME;
        const isControlCall = isControlTool(call.name);
        if (!isControlCall && toolCalls >= limits.max_tool_calls) {
          throw new Error('Maximum tool calls exceeded');
        }

        if (!isControlCall) toolCalls++;
        const callId = call.id || `call_${randomUUID().slice(0, 8)}`;
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
              : await toolRegistry.execute(call.name, call.args || {}, context);
          hasObservation = true;

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
        } catch (error) {
          const output =
            error instanceof ToolExecutionError
              ? error.output
              : {
                  error: {
                    code: 'TOOL_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                    tool: call.name,
                  },
                };
          eventBus.emit('tool.result', {
            call_id: callId,
            status: 'error',
            duration_ms: Date.now() - startedAt,
            output,
          });
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
      throw new Error(`Agent did not call ${FINISH_TOOL_NAME} before reaching the step limit`);
    }

    const content = finalContent;
    const message = createFinalMessage(content);
    eventBus.emit('agent.state', { state: 'respond' });
    eventBus.emit('agent.message.delta', { content });
    eventBus.emit('agent.message.done', { message });

    return { toolCalls, message };
  }

  private async askUser(input: Record<string, unknown>, callId: string, context: ToolContext) {
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

function normalizeAskOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [
      { id: 'continue', label: '继续' },
      { id: 'cancel', label: '取消' },
    ];
  }

  const options = value
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const option = item as Record<string, unknown>;
      const label = typeof option.label === 'string' ? option.label.trim() : '';
      if (!label) return null;
      const rawId = typeof option.id === 'string' ? option.id.trim() : '';

      return {
        id: rawId || `option_${index + 1}`,
        label,
      };
    })
    .filter((option): option is { id: string; label: string } => Boolean(option))
    .slice(0, 5);

  if (options.length >= 2) return options;

  return [
    { id: 'yes', label: '是' },
    { id: 'no', label: '否' },
  ];
}
