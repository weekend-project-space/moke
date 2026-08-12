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
  UpdateSessionEnvironmentInput,
  CreateWorkspaceContextInput,
  ListSkillsInput,
  ListModelsOptions,
  ModelProviderModels,
  SkillSummary,
  WorkspaceContext,
  WorkspaceEntriesInput,
  WorkspaceEntry,
} from './types.js';

export class MokeClient {
  readonly sessions: SessionsResource;
  readonly runs: RunsResource;
  readonly workspace: WorkspaceResource;
  readonly skills: SkillsResource;
  readonly models: ModelsResource;
  private readonly http: HttpClient;
  private readonly runLifecycle: RunLifecycleSubscription;

  constructor(options: MokeClientOptions) {
    this.http = new HttpClient(options);
    this.runLifecycle = new RunLifecycleSubscription(this.http);
    this.sessions = new SessionsResource(this, this.http);
    this.runs = new RunsResource(this.http);
    this.workspace = new WorkspaceResource(this.http);
    this.skills = new SkillsResource(this.http);
    this.models = new ModelsResource(this.http);
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
    const search = new URLSearchParams();
    if (options.includeArchived) search.set('include_archived', 'true');
    if (options.includeHidden) search.set('include_hidden', 'true');
    const query = search.size ? `?${search}` : '';
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

  async updateEnvironment(id: string, input: UpdateSessionEnvironmentInput, options?: RequestOptions) {
    const data = await this.http.request<UpdateSessionResponse>(
      `/api/sessions/${id}/env`, this.http.json('PATCH', input), options,
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
        ...(input.files?.length ? { files: input.files } : {}),
      },
      ...(input.env ? { env: input.env } : {}),
      options: {
        stream: true,
        ...input.limits,
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
  readonly workspace: SessionWorkspaceResource;
  readonly skills: SessionSkillsResource;

  constructor(protected readonly client: MokeClient, readonly id: string) {
    this.workspace = new SessionWorkspaceResource(client.workspace, id);
    this.skills = new SessionSkillsResource(client.skills, id);
  }

  get(options?: RequestOptions) { return this.client.sessions.get(this.id, options); }
  async messages(options?: RequestOptions) { return (await this.get(options)).messages; }
  update(input: UpdateSessionInput, options?: RequestOptions) { return this.client.sessions.update(this.id, input, options); }
  updateEnvironment(input: UpdateSessionEnvironmentInput, options?: RequestOptions) {
    return this.client.sessions.updateEnvironment(this.id, input, options);
  }
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

class WorkspaceResource {
  constructor(private readonly http: HttpClient) {}

  async createContext(input: CreateWorkspaceContextInput, options?: RequestOptions): Promise<WorkspaceContext> {
    const data = await this.http.request<unknown>(
      '/api/workspace/contexts',
      this.http.json('POST', { root: input.workspaceRoot, ttl_ms: input.ttlMs }),
      options,
    );
    return requireWorkspaceContext(data);
  }

  async entries(input: WorkspaceEntriesInput = {}): Promise<WorkspaceEntry[]> {
    const search = new URLSearchParams();
    if (input.sessionId) search.set('session_id', input.sessionId);
    if (input.contextId) search.set('context_id', input.contextId);
    if (input.path) search.set('path', input.path);
    if (input.query) search.set('query', input.query);
    if (input.includeDirectories !== undefined) search.set('include_directories', String(input.includeDirectories));
    if (input.limit !== undefined) search.set('limit', String(input.limit));
    const query = search.size ? `?${search}` : '';
    const data = await this.http.request<unknown>(`/api/workspace/entries${query}`, {}, input);
    return requireWorkspaceEntries(data);
  }
}

class SessionWorkspaceResource {
  constructor(
    private readonly resource: WorkspaceResource,
    private readonly sessionId: string,
  ) {}

  entries(input: Omit<WorkspaceEntriesInput, 'sessionId' | 'contextId'> = {}) {
    return this.resource.entries({ ...input, sessionId: this.sessionId });
  }
}

class SkillsResource {
  constructor(private readonly http: HttpClient) {}

  async list(input: ListSkillsInput = {}): Promise<SkillSummary[]> {
    const search = new URLSearchParams();
    if (input.sessionId) search.set('session_id', input.sessionId);
    if (input.contextId) search.set('context_id', input.contextId);
    if (input.enabledOnly !== undefined) search.set('enabled_only', String(input.enabledOnly));
    const query = search.size ? `?${search}` : '';
    const data = await this.http.request<unknown>(`/api/workspace/skills${query}`, {}, input);
    return requireSkills(data);
  }
}

class SessionSkillsResource {
  constructor(
    private readonly resource: SkillsResource,
    private readonly sessionId: string,
  ) {}

  list(input: Omit<ListSkillsInput, 'sessionId' | 'contextId'> = {}) {
    return this.resource.list({ ...input, sessionId: this.sessionId });
  }
}

class ModelsResource {
  constructor(private readonly http: HttpClient) {}

  async list(options: ListModelsOptions = {}): Promise<ModelProviderModels[]> {
    const search = new URLSearchParams();
    if (options.providerId) search.set('provider_id', options.providerId);
    if (options.refresh) search.set('refresh', 'true');
    const query = search.size ? `?${search}` : '';
    const data = await this.http.request<unknown>(`/api/settings/model/capabilities${query}`, {}, options);
    return requireModelProviderModels(data);
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
    await this.respond(id, {
      type: 'choose',
      request_id: input.requestId,
      ...('optionId' in input ? { option_id: input.optionId } : { custom_text: input.customText }),
    }, options);
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
        const answerInput = typeof answer === 'string'
          ? { optionId: answer }
          : 'customText' in answer
            ? { customText: answer.customText }
            : { optionId: answer.optionId };
        await this.answer({
          requestId: event.payload.ask_id,
          ...answerInput,
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

function requireWorkspaceContext(value: unknown): WorkspaceContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MokeProtocolError('Workspace context response is invalid');
  }
  const data = value as Record<string, unknown>;
  if (typeof data.id !== 'string' || typeof data.root !== 'string') {
    throw new MokeProtocolError('Workspace context response is invalid');
  }
  return {
    id: data.id,
    root: data.root,
    ...(typeof data.expires_at === 'string' ? { expiresAt: data.expires_at } : {}),
  };
}

function requireWorkspaceEntries(value: unknown): WorkspaceEntry[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>).entries
      : undefined;
  if (!Array.isArray(entries)) throw new MokeProtocolError('Workspace entries response is invalid');

  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MokeProtocolError('Workspace entry response is invalid');
    }
    const data = entry as Record<string, unknown>;
    if (typeof data.path !== 'string' || typeof data.name !== 'string') {
      throw new MokeProtocolError('Workspace entry response is invalid');
    }
    return {
      path: data.path,
      name: data.name,
    };
  });
}

function requireSkills(value: unknown): SkillSummary[] {
  const skills = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (value as Record<string, unknown>).skills
      : undefined;
  if (!Array.isArray(skills)) throw new MokeProtocolError('Skills response is invalid');

  return skills.map((skill) => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      throw new MokeProtocolError('Skill response is invalid');
    }
    const data = skill as Record<string, unknown>;
    if (typeof data.name !== 'string' || typeof data.description !== 'string') {
      throw new MokeProtocolError('Skill response is invalid');
    }
    return {
      name: data.name,
      description: data.description,
    };
  });
}

function requireModelProviderModels(value: unknown): ModelProviderModels[] {
  const groups = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).providers
      : undefined;
  if (!Array.isArray(groups)) throw new MokeProtocolError('Models response is invalid');

  return groups.map((group) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new MokeProtocolError('Model provider response is invalid');
    }
    const data = group as Record<string, unknown>;
    if (typeof data.provider !== 'string' || !Array.isArray(data.models)) {
      throw new MokeProtocolError('Model provider response is invalid');
    }
    return {
      provider: data.provider,
      ...(typeof data.provider_name === 'string' ? { providerName: data.provider_name } : {}),
      models: data.models.map((model) => {
        if (!model || typeof model !== 'object' || Array.isArray(model)) {
          throw new MokeProtocolError('Model response is invalid');
        }
        const item = model as Record<string, unknown>;
        if (typeof item.name !== 'string') throw new MokeProtocolError('Model response is invalid');
        return {
          name: item.name,
          ...(typeof item.supports_reasoning === 'boolean'
            ? { supportsReasoning: item.supports_reasoning }
            : {}),
        };
      }),
    };
  });
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
        ...(event.payload.usage.input_tokens !== undefined ? { inputTokens: event.payload.usage.input_tokens } : {}),
        ...(event.payload.usage.output_tokens !== undefined ? { outputTokens: event.payload.usage.output_tokens } : {}),
        ...(event.payload.usage.cached_input_tokens !== undefined
          ? { cachedInputTokens: event.payload.usage.cached_input_tokens }
          : {}),
        ...(event.payload.usage.uncached_input_tokens !== undefined
          ? { uncachedInputTokens: event.payload.usage.uncached_input_tokens }
          : {}),
      };
    } else if (event.type === 'agent.error') {
      error = event.payload;
    }
  }
  return { runId: run.id, sessionId: run.session_id, status: run.status, message, usage, error };
}

export type { ActiveRunSummary, Message };
