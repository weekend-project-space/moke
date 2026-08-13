import { createAgentRunSnapshot, reduceAgentEvent } from '@moke/agent-protocol';
import type { AgentEvent, AgentInteractionResponse, AgentRunInput, AgentRunSnapshot } from '@moke/agent-protocol';
import { readSseData } from './event-stream.js';

export type AgentProtocolClientOptions = { baseUrl: string; token?: string; fetch?: typeof fetch; maxReconnectAttempts?: number; maxReconnectDelayMs?: number };
export type AgentRequestOptions = { signal?: AbortSignal };
export type AgentEventStreamOptions = { afterSequence?: number; reconnect?: boolean; signal?: AbortSignal; onReconnect?: (attempt: number, delayMs: number) => void };

export class AgentProtocolClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  readonly maxReconnectAttempts: number;
  readonly maxReconnectDelayMs: number;
  constructor(private readonly options: AgentProtocolClientOptions) { this.baseUrl = options.baseUrl.replace(/\/+$/, ''); this.fetcher = (options.fetch ?? fetch).bind(globalThis); this.maxReconnectAttempts = options.maxReconnectAttempts ?? 8; this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 5_000; }
  async createRun(input: AgentRunInput, options: AgentRequestOptions = {}) { return this.json<{ threadId: string; runId: string; status: string }>('/api/agent/runs', { method: 'POST', body: JSON.stringify(input) }, options.signal); }
  async getRun(runId: string, signal?: AbortSignal) { return this.json<{ run: AgentRunSnapshot }>(`/api/agent/runs/${encodeURIComponent(runId)}`, {}, signal).then(value => value.run); }
  async respond(runId: string, response: AgentInteractionResponse, signal?: AbortSignal) { return this.json<{ accepted: boolean }>(`/api/agent/runs/${encodeURIComponent(runId)}/respond`, { method: 'POST', body: JSON.stringify(response) }, signal); }
  async cancel(runId: string, reason?: string, signal?: AbortSignal) { return this.json<{ accepted: boolean }>(`/api/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }, signal); }
  events(runId: string, options: AgentEventStreamOptions = {}) { return streamProtocolEvents(this, runId, options); }
  async snapshotFromEvents(threadId: string, runId: string, options: AgentEventStreamOptions = {}) { let snapshot = createAgentRunSnapshot(threadId, runId); for await (const event of this.events(runId, options)) snapshot = reduceAgentEvent(snapshot, event); return snapshot; }
  headers(extra?: HeadersInit) { const headers = new Headers(extra); headers.set('Accept', headers.get('Accept') ?? 'application/json'); if (this.options.token) headers.set('Authorization', `Bearer ${this.options.token}`); return headers; }
  url(path: string) { return `${this.baseUrl}${path}`; }
  get fetch() { return this.fetcher; }
  private async json<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> { const response = await this.fetcher(this.url(path), { ...init, headers: this.headers({ 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(init.headers)) }), signal }); if (!response.ok) throw new Error(`Agent API request failed: HTTP ${response.status}`); return response.json() as Promise<T>; }
}

async function* streamProtocolEvents(client: AgentProtocolClient, runId: string, options: AgentEventStreamOptions): AsyncGenerator<AgentEvent> {
  let sequence = Math.max(0, options.afterSequence ?? 0);
  let attempts = 0;
  const maxAttempts = client.maxReconnectAttempts;
  const maxDelay = client.maxReconnectDelayMs;
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      const headers = client.headers({ Accept: 'text/event-stream' });
      if (sequence) headers.set('Last-Event-ID', String(sequence));
      const response = await client.fetch(client.url(`/api/agent/runs/${encodeURIComponent(runId)}/events`), { headers, signal: options.signal });
      if (!response.ok || !response.body) throw new Error(`Agent event stream failed: HTTP ${response.status}`);
      for await (const data of readSseData(response.body, options.signal)) {
        const event = parseEvent(data, runId);
        if (event.sequence <= sequence) continue;
        sequence = event.sequence; attempts = 0; yield event;
        if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.timed_out' || event.type === 'run.cancelled') return;
      }
    } catch (error) { if (options.signal?.aborted) throw options.signal.reason; if (options.reconnect === false) throw error; }
    if (options.reconnect === false || ++attempts > maxAttempts) throw new Error('Agent event stream reconnect limit exceeded');
    const delayMs = Math.min(500 * 2 ** (attempts - 1), maxDelay); options.onReconnect?.(attempts, delayMs); await delay(delayMs, options.signal);
  }
}

function parseEvent(data: string, runId: string): AgentEvent { const value = JSON.parse(data) as Partial<AgentEvent>; if (!value || typeof value.eventId !== 'string' || typeof value.sequence !== 'number' || typeof value.type !== 'string' || value.runId !== runId || typeof value.threadId !== 'string') throw new Error('Invalid AgentEvent'); return value as AgentEvent; }
function delay(ms: number, signal?: AbortSignal) { return new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }); }
