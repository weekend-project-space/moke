import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

import type { Message } from '../../protocol/src/index.js';
import type { ToolContext } from '../../agent-runtime/src/index.js';
import type { AgentToolSpec } from './control-tools.js';
import { FINISH_TOOL_NAME } from './control-tools.js';

export function createSystemPrompt(customTools: AgentToolSpec[]) {
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

export function createSystemMessage(runtimeTools: AgentToolSpec[], context: ToolContext) {
  const basePrompt = createSystemPrompt(runtimeTools);
  const extraContext = context.contentManager?.buildContext();
  if (!extraContext) return new SystemMessage(basePrompt);

  return new SystemMessage(`${basePrompt}\n\n${extraContext}`);
}

export function createFinalMessage(content: string): Message {
  return {
    id: `msg_${Date.now()}`,
    role: 'assistant',
    content,
    created_at: new Date().toISOString(),
  };
}

export function createHistoryMessages(history: Message[]) {
  const messages: BaseMessage[] = [];

  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    const content = message.content.trim();
    if (!content && message.role !== 'assistant') continue;

    if (message.role === 'user') {
      messages.push(new HumanMessage(content));
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls = message.tool_calls?.filter((call) => call.id && call.name) || [];
      if (toolCalls.length > 0) {
        const toolMessages: ToolMessage[] = [];
        const pendingIds = new Set(toolCalls.map((call) => call.id));
        let cursor = index + 1;

        while (cursor < history.length && pendingIds.size > 0) {
          const toolResult = history[cursor];
          if (toolResult.role !== 'tool' || !pendingIds.has(toolResult.tool_call_id)) break;

          toolMessages.push(
            new ToolMessage({
              content: toolResult.content.trim(),
              tool_call_id: toolResult.tool_call_id,
              name: toolResult.name,
              status: toolResult.status,
            }),
          );
          pendingIds.delete(toolResult.tool_call_id);
          cursor++;
        }

        if (pendingIds.size === 0) {
          messages.push(
            new AIMessage({
              content,
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                args: call.args,
              })),
            }),
            ...toolMessages,
          );
          index = cursor - 1;
          continue;
        }
      }

      messages.push(
        new AIMessage({
          content,
        }),
      );
    }
  }

  return messages;
}

export function getMessageText(message: BaseMessage) {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((item) => ('text' in item ? item.text : '')).join('\n');
}

export function isAI(message: BaseMessage): message is AIMessage {
  return AIMessage.isInstance(message);
}

export function createFinishReminder(aiMessage: BaseMessage) {
  const content = getMessageText(aiMessage).trim();
  const answer = content ? ` Use this answer as finish.content if it is already complete: ${JSON.stringify(content)}` : '';
  return new SystemMessage(`You must call the ${FINISH_TOOL_NAME} tool to end this run.${answer}`);
}
