import type { AgentEvent } from '@moke/protocol';
import { MokeApiError, MokeNetworkError, MokeProtocolError } from './errors.js';
import type { HttpClient } from './http-client.js';
import type { RunEventsOptions } from './types.js';

const TERMINAL_EVENTS = new Set(['agent.done', 'agent.error']);

export async function* streamRunEvents(
  http: HttpClient,
  runId: string,
  options: RunEventsOptions = {},
): AsyncGenerator<AgentEvent> {
  let lastSeq = options.afterSeq ?? 0;
  let attempt = 0;
  const reconnect = options.reconnect !== false;
  const maxDelay = options.maxReconnectDelayMs ?? 5_000;

  while (true) {
    throwIfAborted(options.signal);
    let endedNormally = false;
    try {
      const response = await http.fetcher(`${http.baseUrl}/api/runs/${runId}/events`, {
        headers: http.headers({ Accept: 'text/event-stream' }),
        signal: options.signal,
      });
      if (!response.ok) throw await toApiError(response);
      if (!response.body) throw new MokeProtocolError('Event response has no body');

      for await (const data of readSseData(response.body, options.signal)) {
        const event = parseAgentEvent(data);
        if (event.run_id !== runId) throw new MokeProtocolError('Event run_id does not match subscription');
        if (event.seq <= lastSeq) continue;
        lastSeq = event.seq;
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
    }

    if (!reconnect) {
      if (endedNormally) throw new MokeNetworkError('Event stream ended before a terminal event');
      return;
    }
    attempt += 1;
    await delay(Math.min(500 * 2 ** (attempt - 1), maxDelay), options.signal);
  }
}

async function* readSseData(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
      if (done) return;
    }
  } finally {
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
  const event = value as Partial<AgentEvent>;
  if (
    typeof event.id !== 'string'
    || typeof event.seq !== 'number'
    || typeof event.type !== 'string'
    || typeof event.run_id !== 'string'
    || typeof event.session_id !== 'string'
    || typeof event.ts !== 'string'
    || !('payload' in event)
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
