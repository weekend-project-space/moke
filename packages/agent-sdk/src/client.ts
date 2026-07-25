import type {
  ActiveRunSummary,
  AgentEvent,
  AssistantMessage,
  CreateSessionResponse,
  ForkSessionResponse,
  GetRunResponse,
  GetSessionResponse,
  ListActiveRunsResponse,
  ListSessionsResponse,
  Message,
  RespondToRunResponse,
  RunSnapshot,
  SendMessageRequest,
  SendMessageResponse,
  Session,
  SessionSummary,
  UpdateSessionResponse,
} from '@moke/protocol';
import { MokeInteractionRequiredError, MokeProtocolError, MokeRunError } from './errors.js';
import { streamRunEvents } from './event-stream.js';
import { HttpClient } from './http-client.js';
import { RunLifecycleSubscription } from './run-lifecycle.js';
import type {
  AnswerRunInput,
  InteractionHandlers,
  InteractionHandlerOverrides,
  ApproveRunInput,
  CreateSessionInput,
  ForkSessionInput,
  ListSessionsOptions,
  MokeClientOptions,
  RunLifecycleListener,
  RunLifecycleOptions,
  SessionRunEventListener,
  SessionRunEventOptions,
  PromptOptions,
  RequestOptions,
  RunEventsOptions,
  RunResult,
  RunResultOptions,
  SendMessageInput,
  UpdateSessionInput,
} from './types.js';

export class MokeClient {
  readonly sessions: SessionsResource;
  readonly runs: RunsResource;
  private readonly http: HttpClient;
  private readonly runLifecycle: RunLifecycleSubscription;

  constructor(options: MokeClientOptions) {
    this.http = new HttpClient(options);
    this.runLifecycle = new RunLifecycleSubscription(this.http);
    this.sessions = new SessionsResource(this, this.http);
    this.runs = new RunsResource(this.http);
  }

  session(id: string) { return new SessionHandle(this, id); }
  run(id: string, sessionId?: string) { return new RunHandle(this, id, sessionId); }
  onRunLifecycle(listener: RunLifecycleListener, options?: RunLifecycleOptions) {
    return this.runLifecycle.add(listener, options);
  }

  async health(options?: RequestOptions) {
    const response = await this.http.request<{ status?: unknown }>('/api/health', {}, options);
    return { status: typeof response.status === 'string' ? response.status : 'ok' };
  }
}

class SessionsResource {
  constructor(
    private readonly client: MokeClient,
    private readonly http: HttpClient,
  ) {}

  async create(input: CreateSessionInput = {}, options?: RequestOptions) {
    const data = await this.http.request<CreateSessionResponse>(
      '/api/sessions', this.http.json('POST', input), options,
    );
    const session = requireObjectWithId(data.session, 'session');
    return new SessionHandle(this.client, session.id);
  }

  async list(options: ListSessionsOptions = {}) {
    const query = options.includeArchived ? '?include_archived=true' : '';
    const data = await this.http.request<ListSessionsResponse>(`/api/sessions${query}`, {}, options);
    if (!Array.isArray(data.sessions)) throw new MokeProtocolError('Session list response is invalid');
    return data.sessions;
  }

  async get(id: string, options?: RequestOptions): Promise<Session> {
    const data = await this.http.request<GetSessionResponse>(`/api/sessions/${id}`, {}, options);
    const summary = requireObjectWithId(data.session, 'session') as SessionSummary & { metadata?: unknown };
    if (!Array.isArray(data.messages)) throw new MokeProtocolError('Session messages response is invalid');
    if (!summary.metadata || typeof summary.metadata !== 'object' || Array.isArray(summary.metadata)) {
      throw new MokeProtocolError('Session metadata response is invalid');
    }
    return { ...summary, messages: data.messages, metadata: summary.metadata as Record<string, unknown> };
  }

  async update(id: string, input: UpdateSessionInput, options?: RequestOptions) {
    const data = await this.http.request<UpdateSessionResponse>(
      `/api/sessions/${id}`, this.http.json('PATCH', input), options,
    );
    return requireObjectWithId(data.session, 'session') as SessionSummary;
  }

  async fork(id: string, input: ForkSessionInput, options?: RequestOptions) {
    const data = await this.http.request<ForkSessionResponse>(
      `/api/sessions/${id}/fork`,
      this.http.json('POST', { message_id: input.messageId, mode: input.mode || 'after' }),
      options,
    );
    const session = requireObjectWithId(data.session, 'session');
    return new SessionHandle(this.client, session.id);
  }

  async send(id: string, input: SendMessageInput, options?: RequestOptions) {
    const body: SendMessageRequest = {
      message: {
        role: 'user',
        content: input.content,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
      options: {
        stream: true,
        ...input.limits,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      },
    };
    const data = await this.http.request<SendMessageResponse>(
      `/api/sessions/${id}/messages`, this.http.json('POST', body), options,
    );
    if (typeof data.run_id !== 'string' || typeof data.session_id !== 'string') {
      throw new MokeProtocolError('Run creation response is invalid');
    }
    return new RunHandle(this.client, data.run_id, data.session_id);
  }
}

export class SessionHandle {
  constructor(protected readonly client: MokeClient, readonly id: string) {}

  get(options?: RequestOptions) { return this.client.sessions.get(this.id, options); }
  async messages(options?: RequestOptions) { return (await this.get(options)).messages; }
  update(input: UpdateSessionInput, options?: RequestOptions) { return this.client.sessions.update(this.id, input, options); }
  rename(title: string, options?: RequestOptions) { return this.update({ title }, options); }
  pin(pinned = true, options?: RequestOptions) { return this.update({ pinned }, options); }
  archive(options?: RequestOptions) { return this.update({ archived: true }, options); }
  fork(input: ForkSessionInput, options?: RequestOptions) { return this.client.sessions.fork(this.id, input, options); }
  send(input: SendMessageInput, options?: RequestOptions) { return this.client.sessions.send(this.id, input, options); }
  onRunEvent(listener: SessionRunEventListener, options?: SessionRunEventOptions) {
    return subscribeSessionRunEvents(this.client, this.id, listener, options);
  }

  withHandlers(handlers: InteractionHandlers) {
    return new InteractiveSessionHandle(this.client, this.id, handlers);
  }

  async prompt(input: SendMessageInput, options: PromptOptions = {}) {
    const run = await this.send(input, options);
    return run.consume(options);
  }
}

export class InteractiveSessionHandle extends SessionHandle {
  constructor(
    client: MokeClient,
    id: string,
    private readonly boundHandlers: InteractionHandlers,
  ) {
    super(client, id);
  }

  override withHandlers(handlers: InteractionHandlers) {
    return new InteractiveSessionHandle(this.client, this.id, {
      ...this.boundHandlers,
      ...handlers,
    });
  }

  override async prompt(input: SendMessageInput, options: PromptOptions = {}) {
    const run = await this.send(input, options);
    return run.consume({
      ...options,
      handlers: mergeHandlers(this.boundHandlers, options.handlers),
    });
  }
}

class RunsResource {
  constructor(private readonly http: HttpClient) {}

  async get(id: string, options?: RequestOptions) {
    const data = await this.http.request<GetRunResponse>(`/api/runs/${id}`, {}, options);
    return requireRun(data.run);
  }

  async listActive(options?: RequestOptions) {
    const data = await this.http.request<ListActiveRunsResponse>('/api/runs/active', {}, options);
    if (!Array.isArray(data.runs)) throw new MokeProtocolError('Active run response is invalid');
    return data.runs;
  }

  events(id: string, options?: RunEventsOptions) { return streamRunEvents(this.http, id, options); }

  async cancel(id: string, options?: RequestOptions) {
    await this.respond(id, { type: 'cancel', reason: 'User cancelled' }, options);
    return this.get(id, options);
  }

  async answer(id: string, input: AnswerRunInput, options?: RequestOptions) {
    await this.respond(id, { type: 'choose', request_id: input.requestId, option_id: input.optionId }, options);
    return this.get(id, options);
  }

  async approve(id: string, input: ApproveRunInput, options?: RequestOptions) {
    await this.respond(id, {
      type: 'approve', request_id: input.requestId, decision: input.decision,
      scope: input.scope, message: input.message,
    }, options);
    return this.get(id, options);
  }

  private respond(id: string, body: unknown, options?: RequestOptions) {
    return this.http.request<RespondToRunResponse>(
      `/api/runs/${id}/respond`, this.http.json('POST', body), options,
    );
  }
}

export class RunHandle {
  constructor(
    private readonly client: MokeClient,
    readonly id: string,
    readonly sessionId?: string,
  ) {}

  get(options?: RequestOptions) { return this.client.runs.get(this.id, options); }
  events(options?: RunEventsOptions) { return this.client.runs.events(this.id, options); }
  cancel(options?: RequestOptions) { return this.client.runs.cancel(this.id, options); }
  answer(input: AnswerRunInput, options?: RequestOptions) { return this.client.runs.answer(this.id, input, options); }
  approve(input: ApproveRunInput, options?: RequestOptions) { return this.client.runs.approve(this.id, input, options); }

  async result(options?: RunResultOptions): Promise<RunResult> {
    const snapshot = await this.get(options);
    if (isTerminal(snapshot.status)) return resultFromSnapshot(snapshot);
    for await (const _event of this.events(options)) {
      // The terminal snapshot is the source of truth for the final result.
    }
    return resultFromSnapshot(await this.get(options));
  }

  async consume(options: PromptOptions = {}) {
    const handlers = normalizeHandlers(options.handlers);
    let finalEvent: AgentEvent | undefined;
    for await (const event of this.events(options)) {
      finalEvent = event;
      const context = {
        run: this,
        session: this.client.session(this.sessionId || event.session_id),
      };
      await handlers.onEvent?.(event, context);
      if (event.type === 'ask_user.required') {
        if (!handlers.onAsk) throw new MokeInteractionRequiredError(this.id, event.payload);
        const answer = await handlers.onAsk(event.payload, context);
        await this.answer({
          requestId: event.payload.ask_id,
          optionId: typeof answer === 'string' ? answer : answer.optionId,
        }, options);
      } else if (event.type === 'approval.required') {
        if (!handlers.onApproval) throw new MokeInteractionRequiredError(this.id, event.payload);
        const decision = await handlers.onApproval(event.payload, context);
        await this.approve({
          requestId: event.payload.approval_id,
          ...decision,
        }, options);
      }
    }
    const result = await this.result(options);
    if (result.status === 'failed') {
      const error = result.error || (finalEvent?.type === 'agent.error' ? finalEvent.payload : undefined);
      throw new MokeRunError(this.id, error?.code || 'RUN_FAILED', error?.message || 'Run failed');
    }
    return result;
  }
}

function subscribeSessionRunEvents(
  client: MokeClient,
  sessionId: string,
  listener: SessionRunEventListener,
  options: SessionRunEventOptions = {},
) {
  if (options.signal?.aborted) return () => undefined;

  let stopped = false;
  let currentRunId = '';
  let detailController: AbortController | undefined;

  const notifyError = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch (listenerError) {
      console.error(`Session run error listener failed for ${sessionId}`, listenerError);
    }
  };

  const stopDetail = () => {
    detailController?.abort();
    detailController = undefined;
    currentRunId = '';
  };

  const consumeRun = (runId: string) => {
    if (stopped || currentRunId === runId) return;
    stopDetail();

    const run = client.run(runId, sessionId);
    const controller = new AbortController();
    currentRunId = runId;
    detailController = controller;

    void (async () => {
      try {
        for await (const event of run.events({
          signal: controller.signal,
          onReconnect: (attempt, delayMs) => {
            try {
              options.onReconnect?.(run, attempt, delayMs);
            } catch (error) {
              console.error(`Session run reconnect listener failed for ${run.id}`, error);
            }
          },
        })) {
          if (stopped || detailController !== controller) return;
          try {
            listener(event, run);
          } catch (error) {
            console.error(`Session run event listener failed for ${run.id}`, error);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && !stopped && detailController === controller) {
          notifyError(error);
        }
      } finally {
        if (detailController === controller) {
          detailController = undefined;
          currentRunId = '';
        }
      }
    })();
  };

  const stopLifecycle = client.onRunLifecycle((event) => {
    if (event.sessionId !== sessionId || isTerminal(event.type)) return;
    consumeRun(event.runId);
  }, {
    onError: notifyError,
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopLifecycle();
    stopDetail();
    options.signal?.removeEventListener('abort', stop);
  };

  options.signal?.addEventListener('abort', stop, { once: true });
  return stop;
}

function normalizeHandlers(overrides: InteractionHandlerOverrides = {}): InteractionHandlers {
  return {
    ...(overrides.onEvent ? { onEvent: overrides.onEvent } : {}),
    ...(overrides.onAsk ? { onAsk: overrides.onAsk } : {}),
    ...(overrides.onApproval ? { onApproval: overrides.onApproval } : {}),
  };
}

function mergeHandlers(
  bound: InteractionHandlers,
  overrides: InteractionHandlerOverrides = {},
): InteractionHandlers {
  const merged: InteractionHandlers = { ...bound };
  for (const key of ['onEvent', 'onAsk', 'onApproval'] as const) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    if (value === null || value === undefined) delete merged[key];
    else Object.assign(merged, { [key]: value });
  }
  return merged;
}

function requireObjectWithId(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
    throw new MokeProtocolError(`${label} response is invalid`);
  }
  return value as { id: string } & Record<string, unknown>;
}

function requireRun(value: unknown): RunSnapshot {
  const run = requireObjectWithId(value, 'run') as Partial<RunSnapshot>;
  if (typeof run.session_id !== 'string' || typeof run.status !== 'string' || !Array.isArray(run.events)) {
    throw new MokeProtocolError('Run snapshot response is invalid');
  }
  return run as RunSnapshot;
}

function isTerminal(status: string): status is RunResult['status'] {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout';
}

function resultFromSnapshot(run: RunSnapshot): RunResult {
  if (!isTerminal(run.status)) throw new MokeProtocolError(`Run ${run.id} has not finished`);
  let message: AssistantMessage | undefined;
  let usage: RunResult['usage'];
  let error: RunResult['error'];
  for (const event of run.events) {
    if (event.type === 'agent.message.done' && event.payload.message.role === 'assistant') {
      message = event.payload.message;
    } else if (event.type === 'agent.done' && event.payload.usage) {
      usage = {
        steps: event.payload.usage.steps,
        toolCalls: event.payload.usage.tool_calls,
        durationMs: event.payload.usage.duration_ms,
      };
    } else if (event.type === 'agent.error') {
      error = event.payload;
    }
  }
  return { runId: run.id, sessionId: run.session_id, status: run.status, message, usage, error };
}

export type { ActiveRunSummary, Message };
