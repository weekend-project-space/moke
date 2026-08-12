import { LlmClientError } from './types.js';

export type SseEvent = {
  event: string;
  data: unknown;
  id?: string;
};

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) {
    throw new LlmClientError('Streaming response has no body', { kind: 'protocol' });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parse = (block: string): SseEvent | undefined => {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }

    if (data.length === 0) return undefined;
    const raw = data.join('\n');
    if (raw === '[DONE]') return { event: 'done', data: raw, id };
    try {
      return { event, data: JSON.parse(raw) as unknown, id };
    } catch {
      return { event, data: raw, id };
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match?.index !== undefined) {
        const parsed = parse(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (parsed) yield parsed;
        match = /\r?\n\r?\n/.exec(buffer);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parse(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}
