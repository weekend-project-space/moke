import type { ToolCall } from '@moke/protocol';
import type { ResponsesStreamEvent } from './model-adapter-types.js';
import { toToolCallArgs } from './model-adapter-types.js';

export function collectTextValue(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectTextValue).filter(Boolean).join('');
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return collectTextValue(record.text) || collectTextValue(record.content) || collectTextValue(record.delta);
}

function parseJsonRecord(input: string): Record<string, unknown> {
  try {
    return toToolCallArgs(JSON.parse(input));
  } catch {
    return {};
  }
}

export function collectResponseOutput(input: unknown) {
  const toolCalls: ToolCall[] = [];
  const seenToolCalls = new Set<string>();
  const text: string[] = [];

  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'function_call' || record.type === 'function_call_output') {
      const callId = typeof record.call_id === 'string' ? record.call_id : typeof record.id === 'string' ? record.id : '';
      const name = typeof record.name === 'string' ? record.name : '';
      const rawArgs = typeof record.arguments === 'string' ? record.arguments : '{}';
      const key = `${callId}:${name}:${rawArgs}`;
      if (record.type === 'function_call' && name && !seenToolCalls.has(key)) {
        seenToolCalls.add(key);
        toolCalls.push({ id: callId, name, args: parseJsonRecord(rawArgs) });
      }
    }
    if (record.type === 'output_text' || record.type === 'text') {
      const valueText = collectTextValue(record);
      if (valueText) text.push(valueText);
    }
    visit(record.content);
    visit(record.output);
  }

  visit(input);
  return { content: text.join(''), toolCalls };
}

export async function* readSseEvents(response: Response): AsyncGenerator<ResponsesStreamEvent> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  function parseBlock(block: string): ResponsesStreamEvent | undefined {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    const rawData = data.join('\n');
    if (!rawData || rawData === '[DONE]') return undefined;
    try {
      return { event, data: JSON.parse(rawData) };
    } catch {
      return { event, data: rawData };
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = buffer.search(/\r?\n\r?\n/);
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        const separator = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
        buffer = buffer.slice(separatorIndex + separator.length);
        const event = parseBlock(block);
        if (event) yield event;
        separatorIndex = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
