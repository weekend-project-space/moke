import type { AgentEvent } from '@moke/agent-protocol';
import { MokeApiError, MokeNetworkError, MokeProtocolError } from './errors.js';
import type { HttpClient } from './http-client.js';
import type { RunEventsOptions } from './types.js';

const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.timed_out', 'run.cancelled']);

export async function* streamRunEvents(
  http: HttpClient,
  runId: string,
  options: RunEventsOptions = {},
): AsyncGenerator<AgentEvent> {
  let lastSeq = Number.isSafeInteger(options.afterSeq) && (options.afterSeq ?? 0) >= 0
    ? options.afterSeq ?? 0
    : 0;
  let attempt = 0;
  const reconnect = options.reconnect !== false;
  const maxDelay = Math.max(0, options.maxReconnectDelayMs ?? 5_000);
  const maxAttempts = Math.max(0, Math.trunc(options.maxReconnectAttempts ?? 8));
  let lastError: unknown;

  while (true) {
    throwIfAborted(options.signal);
    let endedNormally = false;
    try {
      const headers = http.headers({ Accept: 'text/event-stream' });
      if (lastSeq > 0) headers.set('Last-Event-ID', String(lastSeq));
      const response = await http.fetcher(`${http.baseUrl}/api/runs/${runId}/events`, {
        headers,
        signal: options.signal,
      });
      if (!response.ok) throw await toApiError(response);
      if (!response.body) throw new MokeProtocolError('Event response has no body');

      for await (const data of readSseData(response.body, options.signal)) {
        const event = parseAgentEvent(data);
        if (event.runId !== runId) throw new MokeProtocolError('Event runId does not match subscription');
        if (event.sequence <= lastSeq) continue;
        lastSeq = event.sequence;
        attempt = 0;
        yield event;
        if (TERMINAL_EVENTS.has(event.type)) return;
      }
      endedNormally = true;
      const snapshot = await http.request<{ run?: { status?: unknown } }>(
        `/api/runs/${runId}`,
        {},
        options,
      );
      if (typeof snapshot.run?.status === 'string' && isTerminalStatus(snapshot.run.status)) return;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (error instanceof MokeApiError || error instanceof MokeProtocolError) throw error;
      if (!reconnect) {
        throw new MokeNetworkError(error instanceof Error ? error.message : 'Event stream failed', { cause: error });
      }
      lastError = error;
    }

    if (!reconnect) {
      if (endedNormally) throw new MokeNetworkError('Event stream ended before a terminal event');
      return;
    }
    attempt += 1;
    if (attempt > maxAttempts) {
      throw new MokeNetworkError('Event stream reconnect limit exceeded', { cause: lastError });
    }
    const reconnectDelay = Math.min(500 * 2 ** (attempt - 1), maxDelay);
    options.onReconnect?.(attempt, reconnectDelay);
    await delay(reconnectDelay, options.signal);
  }
}

export async function* readSseData(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
        boundary = buffer.indexOf('\n\n');
      }
      if (done) {
        completed = true;
        return;
      }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseAgentEvent(data: string): AgentEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new MokeProtocolError(`Event contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object') throw new MokeProtocolError('Event must be an object');
  const event = value as Record<string, unknown>;
  if (
    typeof event.eventId !== 'string'
    || typeof event.sequence !== 'number'
    || typeof event.type !== 'string'
    || typeof event.runId !== 'string'
    || typeof event.threadId !== 'string'
    || typeof event.timestamp !== 'number'
  ) {
    throw new MokeProtocolError('Event does not match the AgentEvent protocol');
  }
  return event as AgentEvent;
}

async function toApiError(response: Response) {
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown; details?: unknown } };
    return new MokeApiError(
      response.status,
      typeof body.error?.code === 'string' ? body.error.code : 'HTTP_ERROR',
      typeof body.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`,
      body.error?.details,
    );
  } catch {
    return new MokeApiError(response.status, 'HTTP_ERROR', `HTTP ${response.status}`);
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isTerminalStatus(status: string) {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout';
}
