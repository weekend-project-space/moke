import { randomUUID } from 'node:crypto';

import type { Message, Run, Session, ToolCall } from '../../../packages/protocol/src/index.js';

export type ForkMode = 'after';

export type ForkSessionInput = {
  source: Session;
  messageId: string;
  mode?: ForkMode;
  now: string;
};

export type SessionUpdateInput = {
  title?: unknown;
  archived?: unknown;
};

export type SessionUpdateResult =
  | { ok: true; changed: true }
  | { ok: false; status: 400; code: string; message: string };

const DEFAULT_SESSION_TITLES = new Set(['New Session', '新会话', 'Moke 对话']);
const SESSION_TITLE_LIMIT = 24;

export function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function now() {
  return new Date().toISOString();
}

export function isTerminalRun(run: Run) {
  return ['completed', 'failed', 'cancelled', 'timeout'].includes(run.status);
}

export function summarizeSession(session: Session) {
  const { messages, metadata, ...summary } = session;
  return {
    ...summary,
    archived: metadata?.archived === true,
    preview: messages.find((message) => message.role === 'user')?.content.slice(0, 42) || '',
    message_count: messages.length,
  };
}

export function titleFromFirstUserMessage(content: string) {
  const compact = content
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim();
  if (!compact) return '';

  return Array.from(compact).slice(0, SESSION_TITLE_LIMIT).join('');
}

export function maybeSetTitleFromFirstUserMessage(session: Session, content: string) {
  if (session.metadata?.title_edited === true) return false;
  if (!DEFAULT_SESSION_TITLES.has(session.title)) return false;

  const hasPreviousUserMessage = session.messages.some((message) => message.role === 'user');
  if (hasPreviousUserMessage) return false;

  const title = titleFromFirstUserMessage(content);
  if (!title) return false;

  session.title = title;
  return true;
}

export function applySessionUpdate(session: Session, input: SessionUpdateInput): SessionUpdateResult {
  let changed = false;

  if (Object.hasOwn(input, 'title')) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'title must be a non-empty string' };
    }

    session.title = title;
    session.metadata = {
      ...session.metadata,
      title_edited: true,
    };
    changed = true;
  }

  if (Object.hasOwn(input, 'archived')) {
    if (typeof input.archived !== 'boolean') {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'archived must be a boolean' };
    }

    session.metadata = {
      ...session.metadata,
      archived: input.archived,
    };
    changed = true;
  }

  if (!changed) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'title or archived is required' };
  }

  return { ok: true, changed: true };
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
