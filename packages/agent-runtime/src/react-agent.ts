import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type ToolCall,
} from '@langchain/core/messages';

import type { Message, RuntimeLimits } from '../../protocol/src/index.js';
import type { EventBus } from './event-bus.js';
import { createChatModel, withTimeout } from './llm-client.js';
import { ToolExecutor } from './tool-executor.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';

type AgentRunInput = {
  input: string;
  history?: Message[];
  eventBus: EventBus;
  toolRegistry: ToolRegistry;
  context: ToolContext;
  limits: RuntimeLimits;
};

type ReactAction =
  | {
      type: 'final';
      answer: string;
    }
  | {
      type: 'tool';
      tool: string;
      input: Record<string, unknown>;
    };

function stripHiddenReasoning(text: string) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .trim();
}

function parseJsonFromText(text: string): unknown | null {
  const clean = stripHiddenReasoning(text);
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], clean].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end < start) continue;

    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // Try the next candidate; small local models often wrap or damage JSON.
    }
  }

  return null;
}

function getMessageText(message: AIMessage) {
  return Array.isArray(message.content)
    ? message.content.map((item) => ('text' in item ? item.text : '')).join('\n')
    : message.content;
}

function getToolCalls(message: AIMessage) {
  return (message.tool_calls || []) as ToolCall[];
}

function normalizeAction(value: unknown): ReactAction {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid ReAct action');
  }

  const action = value as Record<string, unknown>;
  const type = typeof action.type === 'string' ? action.type : action.action;

  if (type === 'final' || type === 'answer') {
    return {
      type: 'final',
      answer: typeof action.answer === 'string' ? action.answer : '',
    };
  }

  if (type === 'tool' || type === 'use_tool') {
    const input = action.input || action.tool_input || action.arguments;
    return {
      type: 'tool',
      tool: typeof action.tool === 'string' ? action.tool : '',
      input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
    };
  }

  throw new Error('Unknown ReAct action type');
}

function parseRelaxedAction(text: string): ReactAction | null {
  const clean = stripHiddenReasoning(text);
  const finalMatch = clean.match(/(?:^|\n)\s*Final(?: Answer)?\s*:\s*([\s\S]*)/i);
  if (finalMatch?.[1]?.trim()) {
    return {
      type: 'final',
      answer: finalMatch[1].trim(),
    };
  }

  const actionMatch = clean.match(/(?:^|\n)\s*Action\s*:\s*([a-zA-Z0-9_-]+)/i);
  if (!actionMatch) return null;

  const inputMatch = clean.match(
    /(?:^|\n)\s*Action Input\s*:\s*([\s\S]*?)(?=\n\s*(?:Observation|Thought|Final(?: Answer)?|Action)\s*:|$)/i,
  );
  const rawInput = inputMatch?.[1]?.trim() || '{}';

  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawInput);
    input = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    input = { query: rawInput };
  }

  return {
    type: 'tool',
    tool: actionMatch[1],
    input,
  };
}

function parseActionFromText(text: string): ReactAction {
  const parsed = parseJsonFromText(text);
  if (parsed) {
    try {
      return normalizeAction(parsed);
    } catch {
      // Fall through to relaxed ReAct text parsing.
    }
  }

  const relaxed = parseRelaxedAction(text);
  if (relaxed) return relaxed;

  const answer = stripHiddenReasoning(text);
  return {
    type: 'final',
    answer: answer || '我暂时没有更多可补充的信息。',
  };
}

function createSystemPrompt(tools: ReturnType<ToolRegistry['list']>) {
  const toolList = tools.map((tool) => `${tool.name}: ${tool.description}`).join('\n');

  return `You are Moke, a local-first ReAct agent.

You may either answer directly or request one tool call at a time.
Do not call tools for greetings, small talk, or self-introduction.
Use tools only when the user asks about project files, code, docs, or local context.
Do not include hidden reasoning, chain-of-thought, or <think> blocks.

Available tools:
${toolList}

When native tool calling is available, use the provided tools instead of writing tool JSON.
If native tool calling is not available and you need a tool, return exactly one JSON object.

Fallback direct answer:
{"type":"final","answer":"your answer"}

Fallback tool use:
{"type":"tool","tool":"search","input":{"query":"docs"}}

Tool examples:
{"type":"tool","tool":"search","input":{"query":"README"}}
{"type":"tool","tool":"read_file","input":{"path":"docs/requirements.md"}}

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

export class ReactAgent {
  private readonly toolExecutor = new ToolExecutor();

  async run({ input, history = [], eventBus, toolRegistry, context, limits }: AgentRunInput) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set; ReAct agent requires an LLM provider.');
    }

    const model = createChatModel();
    const modelWithTools = model.bindTools(toolRegistry.list(), {
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 15000);
    const messages: BaseMessage[] = [
      new SystemMessage(createSystemPrompt(toolRegistry.list())),
      ...createHistoryMessages(history),
      new HumanMessage(input),
    ];

    eventBus.emit('agent.started', { input });
    eventBus.emit('agent.plan', {
      mode: 'react',
      planner: 'langchain-tools',
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      tools: toolRegistry.list().map((tool) => tool.name),
    });

    let toolCalls = 0;

    for (let step = 0; step < limits.max_steps; step++) {
      eventBus.emit('agent.state', { state: 'reason' });
      const response = await withTimeout(modelWithTools.invoke(messages), timeoutMs);
      messages.push(response);

      const nativeToolCalls = getToolCalls(response);
      if (nativeToolCalls.length > 0) {
        for (const toolCall of nativeToolCalls) {
          if (toolCalls >= limits.max_tool_calls) {
            throw new Error('Maximum tool calls exceeded');
          }

          toolCalls++;
          eventBus.emit('agent.state', { state: 'act' });
          const callId = toolCall.id || `call_${Date.now()}_${toolCalls}`;
          const observation = await this.toolExecutor.execute({
            callId,
            toolName: toolCall.name,
            input: toolCall.args || {},
            eventBus,
            toolRegistry,
            context,
          });

          messages.push(
            new ToolMessage({
              content: JSON.stringify(observation).slice(0, 6000),
              tool_call_id: callId,
              status: 'error' in observation ? 'error' : 'success',
            }),
          );
        }

        continue;
      }

      const text = getMessageText(response);
      const action = parseActionFromText(text);

      if (action.type === 'final') {
        const content = action.answer || '我暂时没有更多可补充的信息。';
        const message = createFinalMessage(content);

        eventBus.emit('agent.state', { state: 'respond' });
        eventBus.emit('agent.message.delta', { content });
        eventBus.emit('agent.message.done', {
          message,
        });
        return { toolCalls, message };
      }

      if (toolCalls >= limits.max_tool_calls) {
        throw new Error('Maximum tool calls exceeded');
      }

      toolCalls++;
      eventBus.emit('agent.state', { state: 'act' });
      const callId = `call_${Date.now()}_${toolCalls}`;
      const observation = await this.toolExecutor.execute({
        callId,
        toolName: action.tool,
        input: action.input,
        eventBus,
        toolRegistry,
        context,
      });

      messages.push(new HumanMessage(`Observation for ${action.tool}: ${JSON.stringify(observation).slice(0, 6000)}`));
    }

    throw new Error('Maximum ReAct steps exceeded');
  }
}
