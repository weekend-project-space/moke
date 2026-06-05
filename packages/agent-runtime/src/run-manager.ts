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
  constructor(private readonly config: RunManagerConfig) {}

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
      const message = error instanceof Error ? error.message : 'Unknown runtime error';
      run.status = 'failed';
      session.messages.push({
        id: id('msg'),
        role: 'assistant',
        content: `运行失败：${message}`,
        created_at: new Date().toISOString(),
      });
      session.updated_at = new Date().toISOString();
      eventBus.emit('agent.error', {
        code: 'RUNTIME_ERROR',
        message,
      });
    }
  }

  cancel(runId: string) {
    const run = this.config.runs.get(runId);
    if (!run) return null;
    run.abort = true;
    run.status = 'cancelled';

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
