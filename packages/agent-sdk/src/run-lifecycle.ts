import type { RunLifecycleEvent, RunStatus } from '@moke/protocol';
import { MokeApiError, MokeProtocolError } from './errors.js';
import { readSseData } from './event-stream.js';
import { readApiError, type HttpClient } from './http-client.js';
import type { RunLifecycleListener, RunLifecycleOptions } from './types.js';

const TERMINAL_STATUSES = new Set<RunStatus>(['completed', 'failed', 'cancelled', 'timeout']);
const RUN_STATUSES = new Set<RunStatus>([
  'queued',
  'running',
  'awaiting_user',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'timeout',
]);
const MAX_RECONNECT_ATTEMPTS = 8;

type ListenerEntry = {
  listener: RunLifecycleListener;
  options: RunLifecycleOptions;
  onAbort?: () => void;
};

export class RunLifecycleSubscription {
  private readonly listeners = new Set<ListenerEntry>();
  private readonly currentRuns = new Map<string, RunLifecycleEvent>();
  private controller?: AbortController;
  private task?: Promise<void>;

  constructor(private readonly http: HttpClient) {}

  add(listener: RunLifecycleListener, options: RunLifecycleOptions = {}) {
    if (options.signal?.aborted) return () => undefined;

    const entry: ListenerEntry = { listener, options };
    const remove = () => this.remove(entry);
    if (options.signal) {
      entry.onAbort = remove;
      options.signal.addEventListener('abort', remove, { once: true });
    }
    this.listeners.add(entry);
    for (const event of this.currentRuns.values()) this.callListener(entry, event);
    this.start();
    return remove;
  }

  private remove(entry: ListenerEntry) {
    if (!this.listeners.delete(entry)) return;
    if (entry.onAbort) entry.options.signal?.removeEventListener('abort', entry.onAbort);
    if (this.listeners.size > 0) return;
    this.controller?.abort();
    this.currentRuns.clear();
  }

  private start() {
    if (this.task || this.listeners.size === 0) return;
    const controller = new AbortController();
    this.controller = controller;
    const task = this.consume(controller.signal).finally(() => {
      if (this.task !== task) return;
      this.task = undefined;
      this.controller = undefined;
    });
    this.task = task;
  }

  private async consume(signal: AbortSignal) {
    let attempt = 0;
    while (!signal.aborted && this.listeners.size > 0) {
      try {
        const response = await this.http.fetcher(`${this.http.baseUrl}/api/runs/lifecycle`, {
          headers: this.http.headers({ Accept: 'text/event-stream' }),
          signal,
        });
        if (!response.ok) throw await readApiError(response);
        if (!response.body) throw new MokeProtocolError('Run lifecycle response has no body');

        for await (const data of readSseData(response.body, signal)) {
          const event = parseLifecycleEvent(data);
          attempt = 0;
          if (TERMINAL_STATUSES.has(event.type)) this.currentRuns.delete(event.runId);
          else this.currentRuns.set(event.runId, event);
          this.notify(event);
        }
        if (!signal.aborted) throw new Error('Run lifecycle stream ended');
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof MokeApiError || error instanceof MokeProtocolError) {
          this.notifyError(error);
          return;
        }
        attempt += 1;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          this.notifyError(error);
          return;
        }
        this.currentRuns.clear();
        this.notifyReconnect();
        await delay(Math.min(500 * 2 ** (attempt - 1), 5_000), signal);
      }
    }
  }

  private notify(event: RunLifecycleEvent) {
    for (const entry of this.listeners) this.callListener(entry, event);
  }

  private callListener(entry: ListenerEntry, event: RunLifecycleEvent) {
    try {
      entry.listener(event);
    } catch (error) {
      console.error('Run lifecycle listener failed', error);
    }
  }

  private notifyReconnect() {
    for (const entry of this.listeners) {
      try {
        entry.options.onReconnect?.();
      } catch (error) {
        console.error('Run lifecycle reconnect listener failed', error);
      }
    }
  }

  private notifyError(error: unknown) {
    for (const entry of this.listeners) {
      try {
        entry.options.onError?.(error);
      } catch (listenerError) {
        console.error('Run lifecycle error listener failed', listenerError);
      }
    }
  }
}

function parseLifecycleEvent(data: string): RunLifecycleEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new MokeProtocolError(`Run lifecycle event contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object') throw new MokeProtocolError('Run lifecycle event must be an object');
  const event = value as Partial<RunLifecycleEvent>;
  if (
    typeof event.type !== 'string'
    || !RUN_STATUSES.has(event.type as RunStatus)
    || typeof event.sessionId !== 'string'
    || typeof event.runId !== 'string'
  ) {
    throw new MokeProtocolError('Run lifecycle event does not match the protocol');
  }
  return event as RunLifecycleEvent;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
