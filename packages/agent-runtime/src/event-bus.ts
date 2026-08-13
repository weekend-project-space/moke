import { randomUUID } from 'node:crypto';

import type { AgentEvent, AgentEventInput } from '@moke/agent-protocol';
import type { RuntimeRun } from './run-state.js';

export const MAX_RETAINED_RUN_EVENTS = 2000;

/** Internal session context is durable model history, never public run output. */
export function isPublicAgentEvent(event: AgentEvent) {
  return event.type !== 'custom' || event.name !== 'moke.internal.message';
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function now() { return Date.now(); }

export class EventBus {
  constructor(
    private readonly run: RuntimeRun,
    private readonly onEvent?: (event: AgentEvent) => void,
  ) {}

  emit(input: AgentEventInput, options: { timestamp?: number } = {}) {
    const event: AgentEvent = {
      ...input,
      eventId: id('evt'),
      sequence: ++this.run.seq,
      threadId: this.run.session_id,
      runId: this.run.id,
      timestamp: options.timestamp ?? now(),
    } as AgentEvent;

    this.run.events.push(event);
    if (this.run.events.length > MAX_RETAINED_RUN_EVENTS) {
      this.run.events.splice(0, this.run.events.length - MAX_RETAINED_RUN_EVENTS);
    }
    this.onEvent?.(event);
    if (isPublicAgentEvent(event)) {
      const sse = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of this.run.clients) res.write(sse);
    }

    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.timed_out' || event.type === 'run.cancelled') {
      for (const res of this.run.clients) res.end();
      this.run.clients.clear();
    }

    return event;
  }
}
