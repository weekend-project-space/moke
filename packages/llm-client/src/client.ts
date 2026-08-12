import { createProvider, type ProviderAdapter, type ProviderEvent, type ResolvedRequest } from './providers.js';
import {
  LlmClientError,
  type ChatRequest,
  type ChatResponse,
  type ChatRun,
  type ChatRunSnapshot,
  type ChatRunStatus,
  type LlmClient,
  type LlmClientOptions,
  type LlmStreamEvent,
  type StreamEventContext,
  type StreamingChatResponseHandler,
  type TokenUsage,
  type ToolCall,
} from './types.js';

function runId() {
  return globalThis.crypto?.randomUUID?.() || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function toRequest(input: string | ChatRequest, options: LlmClientOptions): ResolvedRequest {
  const request = typeof input === 'string' ? { input } : input;
  if (!request.input || (typeof request.input === 'string' && !request.input.trim())) {
    throw new LlmClientError('Chat input is required', { kind: 'invalid_request', provider: options.provider });
  }
  return {
    ...request,
    model: request.model || options.model,
    timeoutMs: request.timeoutMs || options.timeoutMs || 120_000,
    store: request.store ?? options.store,
  };
}

function normalizeError(error: unknown, provider: string) {
  if (error instanceof LlmClientError) return error;
  return new LlmClientError(error instanceof Error ? error.message : String(error), {
    kind: 'provider',
    provider,
    cause: error,
  });
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

class ChatRunImpl implements ChatRun {
  readonly id = runId();
  private readonly abortController = new AbortController();
  private readonly completion = deferred<ChatResponse>();
  private readonly bufferedEvents: LlmStreamEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private currentStatus: ChatRunStatus = 'pending';
  private currentSnapshot: ChatRunSnapshot = { id: this.id, status: 'pending', text: '', thinking: '', toolCalls: [] };
  private sequence = 0;
  private terminal = false;
  private cancelReason?: string;
  private eventConsumerCreated = false;
  private handlerQueue = Promise.resolve();
  private externalAbort?: () => void;

  constructor(
    private readonly request: ResolvedRequest,
    private readonly options: LlmClientOptions,
    private readonly providerAdapter: ProviderAdapter,
    private readonly handler?: StreamingChatResponseHandler,
  ) {
    this.completion.promise.catch(() => undefined);
    const externalSignal = request.signal;
    if (externalSignal?.aborted) this.cancel(String(externalSignal.reason || 'Aborted'));
    else if (externalSignal) {
      this.externalAbort = () => this.cancel(String(externalSignal.reason || 'Aborted'));
      externalSignal.addEventListener('abort', this.externalAbort, { once: true });
    }
    queueMicrotask(() => void this.execute());
  }

  status() {
    return this.currentStatus;
  }

  snapshot() {
    return {
      ...this.currentSnapshot,
      toolCalls: [...this.currentSnapshot.toolCalls],
      usage: this.currentSnapshot.usage ? { ...this.currentSnapshot.usage } : undefined,
    };
  }

  async *events(): AsyncIterable<LlmStreamEvent> {
    if (this.eventConsumerCreated) {
      throw new LlmClientError('Only one event iterator is supported per ChatRun', { kind: 'invalid_request' });
    }
    this.eventConsumerCreated = true;
    let index = 0;
    while (true) {
      while (index < this.bufferedEvents.length) yield this.bufferedEvents[index++];
      if (this.terminal) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  result() {
    return this.completion.promise;
  }

  cancel(reason = 'Cancelled') {
    if (this.terminal) return;
    this.cancelReason = reason;
    this.abortController.abort(reason);
    this.finishCancelled(reason);
  }

  private async execute() {
    if (this.terminal) return;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort('timeout'), this.request.timeoutMs);
    const abort = () => timeoutController.abort(this.abortController.signal.reason);
    this.abortController.signal.addEventListener('abort', abort, { once: true });

    try {
      let attempt = 0;
      const maxRetries = Math.max(0, Math.min(6, Math.trunc(this.options.maxRetries || 0)));
      while (!this.terminal) {
        let emittedVisibleEvent = false;
        try {
          for await (const providerEvent of this.providerAdapter.stream(this.request, {
            fetch: this.options.fetch || globalThis.fetch,
            signal: timeoutController.signal,
          })) {
            if (this.terminal) return;
            if (providerEvent.type !== 'raw') emittedVisibleEvent = true;
            this.accept(providerEvent);
          }
          if (!this.terminal) throw new LlmClientError('Provider stream ended without a terminal event', { kind: 'protocol', provider: this.options.provider });
          return;
        } catch (error) {
          if (this.terminal) return;
          if (timeoutController.signal.aborted) {
            if (this.abortController.signal.aborted) {
              this.finishCancelled(this.cancelReason || 'Cancelled');
            } else {
              this.finishFailed(new LlmClientError(`LLM request timed out after ${this.request.timeoutMs}ms`, {
                kind: 'timeout',
                provider: this.options.provider,
                retryable: true,
                cause: error,
              }));
            }
            return;
          }
          const normalized = normalizeError(error, this.options.provider);
          if (!emittedVisibleEvent && normalized.retryable && attempt < maxRetries) {
            try {
              await sleep(Math.min(2_000, 250 * 2 ** attempt), timeoutController.signal);
            } catch (sleepError) {
              if (this.abortController.signal.aborted) this.finishCancelled(this.cancelReason || 'Cancelled');
              else this.finishFailed(new LlmClientError(`LLM request timed out after ${this.request.timeoutMs}ms`, {
                kind: 'timeout',
                provider: this.options.provider,
                retryable: true,
                cause: sleepError,
              }));
              return;
            }
            attempt += 1;
            continue;
          }
          this.finishFailed(normalized);
          return;
        }
      }
    } finally {
      clearTimeout(timer);
      this.abortController.signal.removeEventListener('abort', abort);
    }
  }

  private accept(event: ProviderEvent) {
    switch (event.type) {
      case 'started': {
        this.currentStatus = 'running';
        const payload = event.payload as { responseId?: string };
        this.currentSnapshot = { ...this.currentSnapshot, status: 'running', responseId: payload.responseId, startedAt: new Date().toISOString() };
        this.emit('run.started', payload, event);
        break;
      }
      case 'text.delta': {
        const payload = event.payload as { delta: string };
        this.currentSnapshot = { ...this.currentSnapshot, text: this.currentSnapshot.text + payload.delta };
        this.emit('text.delta', payload, event);
        break;
      }
      case 'text.completed':
        this.emit('text.completed', event.payload as { text: string }, event);
        break;
      case 'thinking.delta': {
        const payload = event.payload as { delta: string; visibility: 'summary' | 'provider_exposed' };
        this.currentSnapshot = { ...this.currentSnapshot, thinking: this.currentSnapshot.thinking + payload.delta };
        this.emit('thinking.delta', payload, event);
        break;
      }
      case 'thinking.completed':
        this.emit('thinking.completed', event.payload as { text: string; visibility: 'summary' | 'provider_exposed' }, event);
        break;
      case 'tool_call.delta':
        this.emit('tool_call.delta', event.payload as { callId: string; name?: string; argumentsDelta: string }, event);
        break;
      case 'tool_call.completed': {
        const toolCall = event.payload as ToolCall;
        if (!this.currentSnapshot.toolCalls.some((item) => item.callId === toolCall.callId)) {
          this.currentSnapshot = { ...this.currentSnapshot, toolCalls: [...this.currentSnapshot.toolCalls, toolCall] };
        }
        this.emit('tool_call.completed', toolCall, event);
        break;
      }
      case 'usage': {
        const usage = event.payload as TokenUsage;
        this.currentSnapshot = { ...this.currentSnapshot, usage };
        this.emit('usage.updated', usage, event);
        break;
      }
      case 'raw':
        this.emit('provider.raw', event.payload as { provider: string; type: string; raw: unknown }, event);
        break;
      case 'completed': {
        const payload = event.payload as Omit<ChatResponse, 'runId' | 'provider' | 'status'>;
        const response: ChatResponse = {
          ...payload,
          runId: this.id,
          provider: this.options.provider,
          status: 'completed',
        };
        this.currentStatus = 'completed';
        this.currentSnapshot = {
          ...this.currentSnapshot,
          status: 'completed',
          text: response.text,
          toolCalls: response.toolCalls,
          usage: response.usage,
          responseId: response.id,
          completedAt: new Date().toISOString(),
        };
        this.emit('run.completed', response, event);
        this.terminal = true;
        this.releaseExternalSignal();
        this.wakeWaiters();
        this.completion.resolve(response);
        break;
      }
    }
  }

  private emit<T extends LlmStreamEvent['type']>(type: T, payload: Extract<LlmStreamEvent, { type: T }>['payload'], source?: ProviderEvent) {
    const event = {
      version: 1,
      type,
      runId: this.id,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      responseId: source?.responseId || this.currentSnapshot.responseId,
      itemId: source?.itemId,
      provider: { name: this.options.provider, eventType: source?.eventType },
      payload,
    } as Extract<LlmStreamEvent, { type: T }>;
    this.bufferedEvents.push(event);
    this.wakeWaiters();
    this.dispatchHandler(event);
  }

  private finishFailed(error: LlmClientError) {
    if (this.terminal) return;
    this.currentStatus = 'failed';
    this.currentSnapshot = { ...this.currentSnapshot, status: 'failed', completedAt: new Date().toISOString() };
    this.emit('run.failed', error);
    this.terminal = true;
    this.releaseExternalSignal();
    this.wakeWaiters();
    this.completion.reject(error);
  }

  private finishCancelled(reason?: string) {
    if (this.terminal) return;
    this.currentStatus = 'cancelled';
    this.currentSnapshot = { ...this.currentSnapshot, status: 'cancelled', completedAt: new Date().toISOString() };
    this.emit('run.cancelled', { reason });
    this.terminal = true;
    this.releaseExternalSignal();
    this.wakeWaiters();
    this.completion.reject(new LlmClientError(reason || 'Cancelled', { kind: 'cancelled', provider: this.options.provider }));
  }

  private wakeWaiters() {
    for (const wake of this.waiters.splice(0)) wake();
  }

  private releaseExternalSignal() {
    if (this.request.signal && this.externalAbort) {
      this.request.signal.removeEventListener('abort', this.externalAbort);
      this.externalAbort = undefined;
    }
  }

  private dispatchHandler(event: LlmStreamEvent) {
    if (!this.handler) return;
    this.handlerQueue = this.handlerQueue.then(() => {
      const context = {
        version: event.version,
        runId: event.runId,
        sequence: event.sequence,
        timestamp: event.timestamp,
        responseId: event.responseId,
        itemId: event.itemId,
        provider: event.provider,
      } satisfies StreamEventContext;
      switch (event.type) {
        case 'run.started': this.handler?.onStarted?.(event.payload, context); break;
        case 'text.delta': this.handler?.onTextDelta?.({ text: event.payload.delta }, context); break;
        case 'text.completed': this.handler?.onTextCompleted?.(event.payload, context); break;
        case 'thinking.delta': this.handler?.onThinkingDelta?.({ text: event.payload.delta, visibility: event.payload.visibility }, context); break;
        case 'thinking.completed': this.handler?.onThinkingCompleted?.(event.payload, context); break;
        case 'tool_call.delta': this.handler?.onToolCallDelta?.(event.payload, context); break;
        case 'tool_call.completed': this.handler?.onToolCallCompleted?.(event.payload, context); break;
        case 'usage.updated': this.handler?.onUsageUpdated?.(event.payload, context); break;
        case 'provider.raw': this.handler?.onUnmappedRawEvent?.(event.payload, context); break;
        case 'run.completed': this.handler?.onCompleted(event.payload); break;
        case 'run.failed': this.handler?.onFailed(event.payload); break;
        case 'run.cancelled': this.handler?.onCancelled?.(event.payload); break;
      }
    }).catch((error) => this.options.diagnostics?.onHandlerError?.(error, event));
  }
}

class DefaultLlmClient implements LlmClient {
  readonly provider: string;
  readonly defaultModel: string;
  private readonly adapter: ProviderAdapter;

  constructor(private readonly options: LlmClientOptions) {
    if (!options.apiKey) throw new LlmClientError('apiKey is required', { kind: 'invalid_request', provider: options.provider });
    if (!options.model) throw new LlmClientError('model is required', { kind: 'invalid_request', provider: options.provider });
    this.provider = options.provider;
    this.defaultModel = options.model;
    this.adapter = createProvider(options);
  }

  chat(input: string | ChatRequest, handler?: StreamingChatResponseHandler): ChatRun {
    return new ChatRunImpl(toRequest(input, this.options), this.options, this.adapter, handler);
  }

  complete(input: string | ChatRequest) {
    return this.chat(input).result();
  }
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  return new DefaultLlmClient(options);
}
