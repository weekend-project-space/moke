import { randomUUID } from 'node:crypto';

import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from 'langchain';

import type { Message, RuntimeLimits } from '../../protocol/src/index.js';
import type { EventBus } from './event-bus.js';
import { createChatModel, withTimeout } from './llm-client.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';

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

function createSystemPrompt(customTools: ReturnType<ToolRegistry['list']>) {
  const customToolList = customTools.map((tool) => `${tool.name}: ${tool.description}`).join('\n');

  return `You are Moke, a local-first ReAct agent.

You may either answer directly or request one tool call at a time.
Do not call tools for greetings, small talk, or self-introduction.
Use tools only when the user asks about project files, code, docs, or local context.
Do not include hidden reasoning, chain-of-thought, or <think> blocks.

Available tools:
${customToolList || 'None'}

Guidelines:
- Prefer Chinese when the user writes Chinese.
- For repository search, use short file or repository keywords: README, docs, requirements, agent, server, client, runtime, package, tauri, vue.
- Use ask_user only when you cannot continue without a user decision; ask one concise question and provide 2 to 5 short options.
- After receiving observations, produce a final answer when you have enough information.
- Never invent file contents you did not observe.`;
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

export class ReactAgent {
  async run({ input, history = [], eventBus, toolRegistry, context, limits }: AgentRunInput): Promise<AgentRunResult> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set; ReAct agent requires an LLM provider.');
    }

    const model = createChatModel();
    const timeoutMs = limits.timeout_ms || Number(process.env.OPENAI_TIMEOUT_MS || 15000);
    const runtimeTools = toolRegistry.list();
    const tools = runtimeTools.map((runtimeTool) =>
      tool(
        async (toolInput) => {
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
      new SystemMessage(createSystemPrompt(runtimeTools)),
      ...createHistoryMessages(history),
      new HumanMessage(input),
    ];
    let toolCalls = 0;
    let finalContent = '';

    eventBus.emit('agent.started', { input });
    eventBus.emit('agent.plan', {
      mode: 'react',
      planner: 'manual-model-loop',
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      tools: runtimeTools.map((tool) => tool.name),
    });

    for (let step = 0; step < limits.max_steps; step++) {
      eventBus.emit('agent.state', { state: 'reason' });

      const aiMessage = await withTimeout(modelWithTools.invoke(messages), timeoutMs);
      messages.push(aiMessage);

      const calls = isAI(aiMessage) ? aiMessage.tool_calls || [] : [];
      if (calls.length === 0) {
        finalContent = getMessageText(aiMessage).trim();
        break;
      }

      eventBus.emit('agent.state', { state: 'act' });
      for (const call of calls) {
        if (toolCalls >= limits.max_tool_calls) {
          throw new Error('Maximum tool calls exceeded');
        }

        toolCalls++;
        const callId = call.id || `call_${randomUUID().slice(0, 8)}`;
        const runtimeTool = toolRegistry.get(call.name);
        eventBus.emit('tool.call', {
          call_id: callId,
          tool: call.name,
          input: call.args || {},
          risk: runtimeTool?.risk || 'safe',
        });

        const startedAt = Date.now();
        try {
          const output =
            call.name === 'ask_user'
              ? await this.askUser(call.args || {}, callId, context)
              : await toolRegistry.execute(call.name, call.args || {}, context);

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
          const output = {
            error: error instanceof Error ? error.message : String(error),
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
    }

    const content = finalContent || '我暂时没有更多可补充的信息。';
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
