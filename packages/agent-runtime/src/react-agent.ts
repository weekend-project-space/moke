import { randomUUID } from 'node:crypto';

import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createAgent } from 'langchain';

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

type AgentStreamState = {
  messages?: BaseMessage[];
};

function createSystemPrompt(tools: ReturnType<ToolRegistry['list']>) {
  const toolList = tools.map((tool) => `${tool.name}: ${tool.description}`).join('\n');

  return `You are Moke, a local-first ReAct agent.

You may either answer directly or request one tool call at a time.
Do not call tools for greetings, small talk, or self-introduction.
Use tools only when the user asks about project files, code, docs, or local context.
Do not include hidden reasoning, chain-of-thought, or <think> blocks.

Available tools:
${toolList}

Guidelines:
- Prefer Chinese when the user writes Chinese.
- For repository search, use short file or repository keywords: README, docs, requirements, agent, server, client, runtime, package, tauri, vue.
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

function getMessageType(message: BaseMessage) {
  return message._getType();
}

function getMessageKey(message: BaseMessage) {
  const id = 'id' in message && typeof message.id === 'string' ? message.id : undefined;
  return id || `${getMessageType(message)}:${getMessageText(message)}`;
}

function isAI(message: BaseMessage): message is AIMessage {
  return AIMessage.isInstance(message);
}

function isTool(message: BaseMessage): message is ToolMessage {
  return ToolMessage.isInstance(message);
}

function summarizeToolOutput(output: unknown) {
  if (typeof output === 'string') {
    try {
      return JSON.parse(output) as Record<string, unknown>;
    } catch {
      return { content: output };
    }
  }

  return output && typeof output === 'object' ? (output as Record<string, unknown>) : { content: String(output) };
}

export class ReactAgent {
  async run({ input, history = [], eventBus, toolRegistry, context, limits }: AgentRunInput): Promise<AgentRunResult> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set; ReAct agent requires an LLM provider.');
    }

    const model = createChatModel();
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 15000);
    const tools = toolRegistry.list().map((runtimeTool) =>
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
    const agent = createAgent({
      model,
      tools,
      version: 'v2',
    });
    const messages = [new SystemMessage(createSystemPrompt(toolRegistry.list())), ...createHistoryMessages(history), new HumanMessage(input)];
    const seen = new Set<string>();
    let toolCalls = 0;
    let finalContent = '';

    eventBus.emit('agent.started', { input });
    eventBus.emit('agent.plan', {
      mode: 'react',
      planner: 'langgraph-react-agent',
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      tools: toolRegistry.list().map((tool) => tool.name),
    });

    const stream = await withTimeout(
      agent.stream(
        { messages },
        {
          streamMode: 'values',
          recursionLimit: Math.max(2, limits.max_steps * 2),
        },
      ),
      timeoutMs,
    );

    for await (const state of stream as AsyncIterable<AgentStreamState>) {
      const stateMessages = state.messages || [];
      for (const message of stateMessages) {
        const key = getMessageKey(message);
        if (seen.has(key)) continue;
        seen.add(key);

        if (isAI(message)) {
          const calls = message.tool_calls || [];
          if (calls.length > 0) {
            eventBus.emit('agent.state', { state: 'act' });
            for (const call of calls) {
              if (toolCalls >= limits.max_tool_calls) {
                throw new Error('Maximum tool calls exceeded');
              }

              toolCalls++;
              eventBus.emit('tool.call', {
                call_id: call.id || `call_${randomUUID().slice(0, 8)}`,
                tool: call.name,
                input: call.args || {},
                risk: toolRegistry.get(call.name)?.risk || 'safe',
              });
            }
            continue;
          }

          const content = getMessageText(message).trim();
          if (content) {
            finalContent = content;
          }
        }

        if (isTool(message)) {
          eventBus.emit('tool.result', {
            call_id: message.tool_call_id,
            status: message.status === 'error' ? 'error' : 'ok',
            duration_ms: 0,
            output: summarizeToolOutput(message.content),
          });
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
}
