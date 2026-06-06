import { randomUUID } from 'node:crypto';

import type { AgentEvent, Message, Run, Session } from '../../protocol/src/index.js';
import { EventBus } from './event-bus.js';
import type { ReactAgent } from './react-agent.js';
import type { ToolRegistry } from './tool-registry.js';

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

type RunManagerConfig = {
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  agent: ReactAgent;
  toolRegistry: ToolRegistry;
  workspace: string;
};

type RunOptions = {
  max_steps?: number;
  max_tool_calls?: number;
  timeout_ms?: number;
};

function readAssistantMessage(event: AgentEvent) {
  const message = event.payload.message;
  if (!message || typeof message !== 'object') return null;

  const candidate = message as Partial<Message>;
  if (candidate.role !== 'assistant' || typeof candidate.content !== 'string') return null;

  return candidate as Message;
}

export class RunManager {
  private readonly pendingAsks = new Map<
    string,
    {
      runId: string;
      resolve: (selected: { id: string; label: string }) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(private readonly config: RunManagerConfig) { }

  createRun(session: Session, content: string, options: RunOptions = {}) {
    const run: Run = {
      id: id('run'),
      session_id: session.id,
      status: 'running',
      seq: 0,
      events: [],
      clients: new Set(),
      started_at: Date.now(),
      abort: false,
    };

    this.config.runs.set(run.id, run);
    void this.execute(run, session, content, options);
    return run;
  }

  private async execute(run: Run, session: Session, content: string, options: RunOptions) {
    let assistantMessageSaved = false;
    const eventBus = new EventBus(run, (event) => {
      if (event.type !== 'agent.message.done') return;

      const message = readAssistantMessage(event);
      if (!message) return;

      session.messages.push(message);
      session.updated_at = message.created_at;
      assistantMessageSaved = true;
    });
    const limits = {
      max_steps: options.max_steps || 6,
      max_tool_calls: options.max_tool_calls || 8,
      timeout_ms: options.timeout_ms || 120000,
    };
    const history = session.messages.slice(0, -1).slice(-12);

    try {
      const result = await this.config.agent.run({
        input: content,
        history,
        eventBus,
        toolRegistry: this.config.toolRegistry,
        context: {
          workspace: this.config.workspace,
          askUser: (input) => this.askUser(run, eventBus, input),
        },
        limits,
      });

      if (run.abort) return;

      if (!assistantMessageSaved) {
        session.messages.push(result.message);
        session.updated_at = result.message.created_at;
      }
      run.status = 'completed';
      eventBus.emit('agent.done', {
        status: 'completed',
        usage: {
          steps: run.seq,
          tool_calls: result.toolCalls,
          duration_ms: Date.now() - run.started_at,
        },
      });
    } catch (error) {
      if (run.abort) return;

      const message = error instanceof Error ? error.message : 'Unknown runtime error';
      const assistantMessage: Message = {
        id: id('msg'),
        role: 'assistant',
        content: `运行失败：${message}`,
        created_at: new Date().toISOString(),
      };
      run.status = 'failed';
      eventBus.emit('agent.message.done', {
        message: assistantMessage,
      });
      eventBus.emit('agent.error', {
        code: 'RUNTIME_ERROR',
        message,
      });
    }
  }

  private askUser(
    run: Run,
    eventBus: EventBus,
    input: { callId: string; question: string; options: Array<{ id: string; label: string }> },
  ): Promise<{ id: string; label: string }> {
    const askId = id('ask');
    run.status = 'awaiting_user';
    run.pending_ask = {
      ask_id: askId,
      call_id: input.callId,
      question: input.question,
      options: input.options,
      created_at: new Date().toISOString(),
    };

    eventBus.emit('ask_user.required', run.pending_ask);

    return new Promise<{ id: string; label: string }>((resolve, reject) => {
      this.pendingAsks.set(askId, {
        runId: run.id,
        resolve,
        reject,
      });
    });
  }

  answer(runId: string, askId: string, optionId: string) {
    const run = this.config.runs.get(runId);
    if (!run) return { status: 404 as const, error: 'Run not found' };
    if (run.pending_ask?.ask_id !== askId) return { status: 409 as const, error: 'Run is not waiting for this answer' };

    const pending = this.pendingAsks.get(askId);
    if (!pending || pending.runId !== runId) return { status: 409 as const, error: 'Ask is no longer pending' };
    const selected = run.pending_ask.options.find((option) => option.id === optionId);
    if (!selected) return { status: 400 as const, error: 'option_id is not valid for this question' };

    this.pendingAsks.delete(askId);
    const pendingAsk = run.pending_ask;
    run.pending_ask = undefined;
    run.status = 'running';

    const session = this.config.sessions.get(run.session_id);
    if (session) {
      const questionCreatedAt = pendingAsk.created_at;
      const answerCreatedAt = new Date().toISOString();
      session.messages.push(
        {
          id: id('msg'),
          role: 'assistant',
          content: pendingAsk.question,
          created_at: questionCreatedAt,
        },
        {
          id: id('msg'),
          role: 'user',
          content: selected.label,
          created_at: answerCreatedAt,
        },
      );
      session.updated_at = answerCreatedAt;
    }

    pending.resolve(selected);

    return { status: 200 as const, run };
  }

  cancel(runId: string) {
    const run = this.config.runs.get(runId);
    if (!run) return null;
    run.abort = true;
    run.status = 'cancelled';

    if (run.pending_ask) {
      const pending = this.pendingAsks.get(run.pending_ask.ask_id);
      this.pendingAsks.delete(run.pending_ask.ask_id);
      run.pending_ask = undefined;
      pending?.reject(new Error('Run cancelled'));
    }

    new EventBus(run).emit('agent.done', {
      status: 'cancelled',
      usage: {
        steps: run.seq,
        tool_calls: 0,
        duration_ms: Date.now() - run.started_at,
      },
    });

    return run;
  }
}
