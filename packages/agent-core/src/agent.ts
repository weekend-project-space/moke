import type { ChatInputItem, InputContentPart, LlmClient, LlmClientError, LlmStreamEvent, ToolCall as ModelToolCall } from '@moke/llm-client';
import type {
  Agent,
  AgentDependencies,
  AgentRun,
  AgentRunOptions,
} from './types.js';
import type {
  AgentCapabilities,
  AgentError,
  AgentEvent,
  AgentEventInput,
  AgentInteractionResponse,
  AgentLimits,
  AgentMessage,
  AgentResult,
  AgentRunInput,
  AgentRunSnapshot,
  AgentRunStatus,
  AgentToolCall,
  AgentUsage,
  AssistantMessage,
  InputContent,
  ToolProvider,
} from '@moke/agent-protocol';

const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 20,
  maxToolCalls: 50,
  maxParallelToolCalls: 4,
  maxDurationMs: 7 * 24 * 60 * 60_000,
  modelTimeoutMs: 120_000,
  toolTimeoutMs: 24 * 60 * 60_000,
};

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

function mapInputContent(content: string | InputContent[]): string | InputContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((part): InputContentPart => {
    if (part.type === 'text') return part;
    if (part.type !== 'image') throw new AgentCoreError('unsupported_multimodal_input', `Unsupported model input type: ${part.type}`, 'input');
    const url = part.source.type === 'url'
      ? part.source.value
      : `data:${part.source.mimeType};base64,${part.source.value}`;
    const detail = part.metadata?.detail;
    return { type: 'image', url, detail: detail === 'low' || detail === 'high' ? detail : 'auto' };
  });
}

function toModelHistory(messages: AgentMessage[]): ChatInputItem[] {
  const history: ChatInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      history.push({ type: 'tool_result', callId: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === 'activity' || message.role === 'reasoning') continue;
    history.push({ type: 'message', role: message.role, content: message.role === 'user' ? mapInputContent(message.content) : message.content ?? '' });
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        history.push({ type: 'tool_call', callId: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  return history;
}

class AgentCoreError extends Error {
  constructor(readonly code: string, message: string, readonly kind: AgentError['kind'], readonly causeValue?: unknown) {
    super(message, { cause: causeValue });
    this.name = 'AgentCoreError';
  }
}

function publicError(error: unknown, stepId?: string): AgentError {
  if (error instanceof AgentCoreError) return { kind: error.kind, code: error.code, message: error.message, retryable: false, stepId };
  const llmError = error as Partial<LlmClientError>;
  if (llmError?.name === 'LlmClientError') return { kind: 'model', code: llmError.kind ?? 'model_error', message: llmError.message ?? 'Model request failed', retryable: Boolean(llmError.retryable), stepId };
  return { kind: 'protocol', code: 'agent_run_failed', message: error instanceof Error ? error.message : String(error), retryable: false, stepId };
}

class Run implements AgentRun {
  readonly threadId: string;
  readonly runId: string;
  private current: AgentRunStatus = 'queued';
  private readonly messages: AgentMessage[];
  private readonly modelHistory: ChatInputItem[];
  private readonly state: Record<string, unknown>;
  private readonly usage: AgentUsage = { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
  private sequence = 0;
  private readonly queue: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private readonly completion: Promise<AgentResult>;
  private resolveResult!: (result: AgentResult) => void;
  private rejectResult!: (error: unknown) => void;
  private readonly controller = new AbortController();
  private activeModelRun?: { cancel(reason?: string): void };
  private lastStepId?: string;

  constructor(private readonly agent: AgentImpl, private readonly input: AgentRunInput, options: AgentRunOptions = {}) {
    this.threadId = input.threadId;
    this.runId = input.runId ?? createId('run');
    this.messages = [...(input.messages ?? [])];
    this.state = { ...(input.state ?? {}) };
    this.modelHistory = toModelHistory(this.messages);
    for (const context of input.context ?? []) {
      this.modelHistory.push({ type: 'message', role: 'user', content: `${context.description}\n${context.value}` });
    }
    const userMessage = { id: createId('msg'), role: 'user' as const, content: input.input };
    this.messages.push(userMessage);
    this.modelHistory.push({ type: 'message', role: 'user', content: mapInputContent(input.input) });
    this.completion = new Promise<AgentResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    options.signal?.addEventListener('abort', () => this.cancel('aborted'), { once: true });
    queueMicrotask(() => void this.execute());
  }

  status() { return this.current; }
  snapshot(): AgentRunSnapshot {
    return { threadId: this.threadId, runId: this.runId, status: this.current, messages: [...this.messages], state: { ...this.state }, activities: this.messages.filter(message => message.role === 'activity'), lastSequence: this.sequence, usage: { ...this.usage } };
  }
  result() { return this.completion; }
  async respond(_response: AgentInteractionResponse) { throw new AgentCoreError('no_pending_interaction', 'Agent run has no pending interaction', 'interaction'); }
  cancel(reason?: string) {
    if (this.isTerminal()) return;
    this.current = 'cancelled';
    this.controller.abort(reason);
    this.activeModelRun?.cancel(reason);
    this.emit({ type: 'run.cancelled', reason });
    this.rejectResult(new AgentCoreError('run_cancelled', reason ?? 'Agent run cancelled', 'cancelled'));
    this.finishEvents();
  }
  async *events(): AsyncIterable<AgentEvent> {
    while (!this.isTerminal() || this.queue.length) {
      if (this.queue.length) yield this.queue.shift()!;
      else {
        const next = await new Promise<IteratorResult<AgentEvent>>(resolve => this.waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  private isTerminal() { return this.current === 'completed' || this.current === 'failed' || this.current === 'cancelled'; }
  private emit(input: AgentEventInput) {
    const event = { ...input, eventId: createId('evt'), sequence: ++this.sequence, threadId: this.threadId, runId: this.runId, timestamp: Date.now() } as AgentEvent;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }
  private finishEvents() { for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }); }

  private async execute() {
    const limits = { ...DEFAULT_LIMITS, ...(this.input.limits ?? {}) };
    const startedAt = Date.now();
    this.current = 'running';
    this.emit({ type: 'run.started', parentRunId: this.input.parentRunId, input: this.input });
    try {
      for (;;) {
        if (this.usage.steps >= limits.maxSteps) throw new AgentCoreError('step_limit', 'Agent step limit exceeded', 'limit');
        if (Date.now() - startedAt > limits.maxDurationMs) throw new AgentCoreError('duration_limit', 'Agent duration limit exceeded', 'limit');
        const stepId = createId('step');
        this.lastStepId = stepId;
        const stepName = `model-${this.usage.steps + 1}`;
        this.usage.steps++;
        this.emit({ type: 'step.started', stepId, stepName });
        const tools = this.resolveTools();
        const modelRun = this.agent.model.chat({
          input: [...this.modelHistory],
          instructions: this.input.instructions,
          tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict })),
          parallelToolCalls: this.agent.capabilities.tools.parallelCalls,
          reasoning: toReasoning(this.input.metadata?.reasoningEffort),
          timeoutMs: limits.modelTimeoutMs,
          metadata: this.input.metadata,
          signal: this.controller.signal,
        });
        this.activeModelRun = modelRun;
        const stream = new StepStream(this, stepId);
        for await (const event of modelRun.events()) stream.accept(event);
        if (this.controller.signal.aborted) return;
        const response = await modelRun.result();
        if (this.controller.signal.aborted) return;
        this.activeModelRun = undefined;
        const assistant = stream.assistantMessage(response.text, response.toolCalls);
        stream.finish(assistant);
        const reasoningMessage = stream.reasoningMessage();
        if (reasoningMessage) this.messages.push(reasoningMessage);
        this.usage.inputTokens += response.usage?.inputTokens ?? 0;
        this.usage.outputTokens += response.usage?.outputTokens ?? 0;
        this.usage.reasoningTokens = (this.usage.reasoningTokens ?? 0) + (response.usage?.reasoningTokens ?? 0);
        this.usage.cachedInputTokens = (this.usage.cachedInputTokens ?? 0) + (response.usage?.cachedTokens ?? 0);
        if (!response.toolCalls.length) {
          this.messages.push(assistant);
          this.modelHistory.push({ type: 'message', role: 'assistant', content: response.text });
          this.emit({ type: 'step.completed', stepId, stepName });
          this.complete(assistant);
          return;
        }
        this.messages.push(assistant);
        if (response.text) this.modelHistory.push({ type: 'message', role: 'assistant', content: response.text });
        for (const call of response.toolCalls) this.modelHistory.push({ type: 'tool_call', callId: call.callId, name: call.name, arguments: call.argumentsJson });
        await this.executeTools(response.toolCalls, stepId, limits);
        this.emit({ type: 'step.completed', stepId, stepName });
      }
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.current = 'failed';
      const details = publicError(error, this.lastStepId);
      this.emit({ type: 'run.failed', error: details });
      this.rejectResult(error);
      this.finishEvents();
    }
  }

  private resolveTools() {
    const tools = this.agent.tools?.listTools({ names: this.input.enabledToolNames }) ?? [];
    if (this.input.enabledToolNames) {
      const available = new Set(tools.map(tool => tool.name));
      const missing = this.input.enabledToolNames.filter(name => !available.has(name));
      if (missing.length) throw new AgentCoreError('unknown_tools', `Unknown or unavailable tools: ${missing.join(', ')}`, 'input');
    }
    return tools;
  }

  private async executeTools(calls: ModelToolCall[], stepId: string, limits: AgentLimits) {
    if (this.usage.toolCalls + calls.length > limits.maxToolCalls) throw new AgentCoreError('tool_call_limit', 'Agent tool call limit exceeded', 'limit');
    this.usage.toolCalls += calls.length;
    const results = await mapConcurrent(calls, Math.max(1, limits.maxParallelToolCalls), call => this.executeTool(call, stepId, limits.toolTimeoutMs));
    for (const result of results) {
      this.messages.push(result.message);
      this.modelHistory.push({ type: 'tool_result', callId: result.message.toolCallId, output: result.modelOutput });
      for (const context of result.context) {
        this.modelHistory.push({ type: 'message', role: context.role ?? 'developer', content: `${context.description}\n${context.value}` });
      }
      if (result.media.length) {
        this.modelHistory.push({ type: 'message', role: 'user', content: mapInputContent(result.media) });
      }
    }
  }

  private async executeTool(call: ModelToolCall, stepId: string, timeoutMs: number) {
    if (!this.agent.tools) throw new AgentCoreError('missing_tool_provider', `No tool provider configured for ${call.name}`, 'tool');
    const toolCall: AgentToolCall = { id: call.callId, type: 'function', function: { name: call.name, arguments: call.argumentsJson } };
    let validated;
    try { validated = this.agent.tools.validate(toolCall); }
    catch (error) { throw new AgentCoreError('invalid_tool_arguments', `Invalid arguments for tool ${call.name}`, 'tool', error); }
    const startedAt = Date.now();
    const result = await withTimeout(this.agent.tools.execute(validated, { threadId: this.threadId, runId: this.runId, stepId, signal: this.controller.signal }), timeoutMs, `Tool ${call.name} timed out`);
    const message = { id: createId('msg'), role: 'tool' as const, content: result.content, toolCallId: call.callId, error: result.error, encryptedValue: result.encryptedValue };
    this.emit({
      type: result.error ? 'tool_result.failed' : 'tool_result.completed',
      stepId,
      messageId: message.id,
      toolCallId: call.callId,
      toolName: call.name,
      content: result.content,
      output: result.output,
      durationMs: Date.now() - startedAt,
      metadata: result.metadata,
      ...(result.error ? { error: { kind: 'tool' as const, code: 'tool_failed', message: result.error, retryable: false, stepId, toolCallId: call.callId } } : {}),
    });
    return {
      message,
      modelOutput: result.output ?? result.content,
      context: result.context ?? [],
      media: result.media ?? [],
    };
  }

  private complete(message: AssistantMessage) {
    this.current = 'completed';
    const result: AgentResult = { threadId: this.threadId, runId: this.runId, status: 'completed', message, messages: [...this.messages], state: { ...this.state }, usage: { ...this.usage } };
    this.emit({ type: 'run.completed', result });
    this.resolveResult(result);
    this.finishEvents();
  }

  streamEmit(input: AgentEventInput) { this.emit(input); }
  exposesRawReasoning() { return this.input.metadata?.showRawReasoning === 'true'; }
}

class StepStream {
  private assistantId?: string;
  private reasoningId?: string;
  private assistantText = '';
  private reasoningText = '';
  private readonly startedTools = new Set<string>();
  private readonly completedTools = new Set<string>();

  constructor(private readonly run: Run, private readonly stepId: string) {}

  accept(event: LlmStreamEvent) {
    if (event.type === 'text.delta' && event.payload.delta) {
      const messageId = this.startAssistant();
      this.assistantText += event.payload.delta;
      this.run.streamEmit({ type: 'message.content', stepId: this.stepId, messageId, delta: event.payload.delta });
    } else if (event.type === 'thinking.delta' && event.payload.delta && (event.payload.visibility === 'summary' || this.run.exposesRawReasoning())) {
      const messageId = this.startReasoning();
      this.reasoningText += event.payload.delta;
      this.run.streamEmit({ type: 'reasoning_message.content', stepId: this.stepId, messageId, delta: event.payload.delta });
    } else if (event.type === 'thinking.completed' && event.payload.text && (event.payload.visibility === 'summary' || this.run.exposesRawReasoning())) {
      const messageId = this.startReasoning();
      const missing = event.payload.text.startsWith(this.reasoningText) ? event.payload.text.slice(this.reasoningText.length) : (this.reasoningText ? '' : event.payload.text);
      if (missing) {
        this.reasoningText += missing;
        this.run.streamEmit({ type: 'reasoning_message.content', stepId: this.stepId, messageId, delta: missing });
      }
    } else if (event.type === 'tool_call.delta') {
      const parentMessageId = this.startAssistant();
      if (!this.startedTools.has(event.payload.callId)) {
        this.startedTools.add(event.payload.callId);
        this.run.streamEmit({ type: 'tool_call.started', stepId: this.stepId, toolCallId: event.payload.callId, toolCallName: event.payload.name ?? '', parentMessageId });
      }
      if (event.payload.argumentsDelta) this.run.streamEmit({ type: 'tool_call.args', stepId: this.stepId, toolCallId: event.payload.callId, delta: event.payload.argumentsDelta });
    } else if (event.type === 'tool_call.completed') {
      this.completeTool(event.payload);
    } else if (event.type === 'provider.raw') {
      this.run.streamEmit({ type: 'raw', stepId: this.stepId, source: event.payload.provider, event: event.payload.raw });
    }
  }

  finish(message: AssistantMessage) {
    const text = message.content ?? '';
    if (text) {
      const messageId = this.startAssistant();
      const missing = text.startsWith(this.assistantText) ? text.slice(this.assistantText.length) : (this.assistantText ? '' : text);
      if (missing) {
        this.assistantText += missing;
        this.run.streamEmit({ type: 'message.content', stepId: this.stepId, messageId, delta: missing });
      }
    }
    if (this.reasoningId) {
      this.run.streamEmit({ type: 'reasoning_message.completed', stepId: this.stepId, messageId: this.reasoningId });
      this.run.streamEmit({ type: 'reasoning.completed', stepId: this.stepId, messageId: this.reasoningId });
    }
    this.run.streamEmit({
      type: 'message.completed',
      stepId: this.stepId,
      messageId: message.id,
      message,
      ...(this.reasoningText ? { reasoning: this.reasoningText } : {}),
    });
  }

  assistantMessage(text: string, toolCalls: ModelToolCall[] = []): AssistantMessage {
    for (const call of toolCalls) this.completeTool(call);
    const content = text || this.assistantText || undefined;
    const id = this.startAssistant();
    return { id, role: 'assistant', content, toolCalls: toolCalls.length ? toolCalls.map(toAgentToolCall) : undefined };
  }

  reasoningMessage() {
    return this.reasoningId ? { id: this.reasoningId, role: 'reasoning' as const, content: this.reasoningText } : undefined;
  }

  private startAssistant() {
    if (!this.assistantId) {
      this.assistantId = createId('msg');
      this.run.streamEmit({ type: 'message.started', stepId: this.stepId, messageId: this.assistantId, role: 'assistant' });
    }
    return this.assistantId;
  }

  private startReasoning() {
    if (!this.reasoningId) {
      this.reasoningId = createId('msg');
      this.run.streamEmit({ type: 'reasoning.started', stepId: this.stepId, messageId: this.reasoningId });
      this.run.streamEmit({ type: 'reasoning_message.started', stepId: this.stepId, messageId: this.reasoningId, role: 'reasoning' });
    }
    return this.reasoningId;
  }

  private completeTool(call: ModelToolCall) {
    if (!this.startedTools.has(call.callId)) {
      const parentMessageId = this.startAssistant();
      this.startedTools.add(call.callId);
      this.run.streamEmit({ type: 'tool_call.started', stepId: this.stepId, toolCallId: call.callId, toolCallName: call.name, parentMessageId });
      if (call.argumentsJson) this.run.streamEmit({ type: 'tool_call.args', stepId: this.stepId, toolCallId: call.callId, delta: call.argumentsJson });
    }
    if (!this.completedTools.has(call.callId)) {
      this.completedTools.add(call.callId);
      this.run.streamEmit({ type: 'tool_call.completed', stepId: this.stepId, toolCallId: call.callId });
    }
  }
}

function toAgentToolCall(call: ModelToolCall): AgentToolCall {
  return { id: call.callId, type: 'function', function: { name: call.name, arguments: call.argumentsJson } };
}

function toReasoning(value: string | undefined) {
  if (value === 'off') return { effort: 'none' as const };
  if (value === 'low') return { effort: 'low' as const };
  if (value === 'medium') return { effort: 'medium' as const };
  if (value === 'high') return { effort: 'high' as const };
  if (value === 'max') return { effort: 'max' as const };
  return undefined;
}

async function mapConcurrent<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AgentCoreError('tool_timeout', message, 'tool')), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

class AgentImpl implements Agent {
  readonly id = createId('agent');
  readonly capabilities: AgentCapabilities;
  constructor(readonly model: LlmClient, readonly tools?: ToolProvider, capabilities?: Partial<AgentCapabilities>) {
    const defaults: AgentCapabilities = {
      tools: { supported: Boolean(tools), parallelCalls: true, clientProvidedTools: false },
      output: { streaming: true, structured: false },
      reasoning: { summary: true, encryptedValue: false },
      multimodal: { input: ['image'] },
      execution: { cancellation: true, maxParallelToolCalls: DEFAULT_LIMITS.maxParallelToolCalls },
    };
    this.capabilities = { ...defaults, ...capabilities };
  }
  run(input: AgentRunInput, options?: AgentRunOptions) { return new Run(this, input, options); }
}

export function createAgent(dependencies: AgentDependencies): Agent {
  return new AgentImpl(dependencies.model, dependencies.tools, dependencies.capabilities);
}
