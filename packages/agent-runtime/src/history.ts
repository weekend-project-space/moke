import type { ImageAttachment, Message, ResolvedImageAttachment } from '@moke/protocol';

import type { RuntimeMessage } from './agent.js';

/** Keep the tail of history without splitting an assistant tool-call group. */
export function selectRecentHistory(messages: Message[], maxMessages = 999) {
  if (messages.length <= maxMessages) return messages.slice();

  const cutoff = Math.max(0, messages.length - maxMessages);
  let start = cutoff;
  const cutoffMessage = messages[start];
  if (cutoffMessage?.role !== 'tool') return messages.slice(start);

  const firstToolCallId = cutoffMessage.tool_call_id;
  while (start > 0) {
    start--;
    const candidate = messages[start];
    if (candidate.role === 'assistant' && candidate.tool_calls?.some((call) => call.id === firstToolCallId)) {
      return messages.slice(start);
    }
    if (candidate.role === 'user') break;
  }

  start = cutoff;
  while (start < messages.length && messages[start]?.role === 'tool') start++;
  return messages.slice(start);
}

export async function resolveHistory(
  messages: Message[],
  resolveImageAttachments?: (
    attachments: ImageAttachment[],
  ) => ResolvedImageAttachment[] | Promise<ResolvedImageAttachment[]>,
): Promise<RuntimeMessage[]> {
  return Promise.all(messages.map(async (message): Promise<RuntimeMessage> => {
    if (message.role !== 'user') return message;
    if (!message.attachments?.length) return { ...message, attachments: undefined };
    if (!resolveImageAttachments) throw new Error('Image attachment resolver is not configured');
    return {
      ...message,
      attachments: await resolveImageAttachments(message.attachments),
    };
  }));
}
