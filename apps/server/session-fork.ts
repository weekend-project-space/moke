import { randomUUID } from 'node:crypto';

import type { Message, Session, ToolCall } from '../../packages/protocol/src/index.js';

export type ForkMode = 'after';

export type ForkSessionInput = {
  source: Session;
  messageId: string;
  mode?: ForkMode;
  now: string;
};

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function cloneToolCall(toolCall: ToolCall, toolCallIds: Map<string, string>): ToolCall {
  const nextId = id('call');
  toolCallIds.set(toolCall.id, nextId);
  return {
    ...toolCall,
    id: nextId,
    args: { ...toolCall.args },
  };
}

function cloneMessage(message: Message, toolCallIds: Map<string, string>): Message {
  if (message.role === 'user') {
    return {
      ...message,
      id: id('msg'),
    };
  }

  if (message.role === 'assistant') {
    return {
      ...message,
      id: id('msg'),
      tool_calls: message.tool_calls?.map((toolCall) => cloneToolCall(toolCall, toolCallIds)),
    };
  }

  return {
    ...message,
    id: id('msg'),
    tool_call_id: toolCallIds.get(message.tool_call_id) || message.tool_call_id,
  };
}

export function forkSession({ source, messageId, now }: ForkSessionInput): Session | null {
  const messageIndex = source.messages.findIndex((message) => message.id === messageId);
  if (messageIndex < 0) return null;

  const toolCallIds = new Map<string, string>();
  const messages = source.messages.slice(0, messageIndex + 1).map((message) => cloneMessage(message, toolCallIds));

  return {
    id: id('sess'),
    title: source.title,
    created_at: now,
    updated_at: now,
    messages,
    metadata: {
      ...source.metadata,
      forked_from: {
        session_id: source.id,
        message_id: messageId,
        message_index: messageIndex,
        created_at: now,
      },
    },
  };
}
