import { randomUUID } from 'node:crypto';

import type { AgentEvent, AgentEventPayloadMap, AgentEventType, AgentStep } from '@moke/protocol';
import type { RuntimeRun } from './run-state.js';

export const MAX_RETAINED_RUN_EVENTS = 2000;

/** Internal session context is durable model history, never public run output. */
export function isPublicAgentEvent(event: AgentEvent) {
  return event.type !== 'agent.message.done'
    || event.payload.message.role !== 'user'
    || event.payload.message.visibility !== 'internal';
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function now() {
  return new Date().toISOString();
}

export class EventBus {
  constructor(
    private readonly run: RuntimeRun,
    private readonly onEvent?: (event: AgentEvent) => void,
  ) {}

  emit<Type extends AgentEventType>(type: Type, payload: AgentEventPayloadMap[Type], options: { step?: AgentStep } = {}) {
    const event: AgentEvent = {
      id: id('evt'),
      seq: ++this.run.seq,
      type,
      run_id: this.run.id,
      session_id: this.run.session_id,
      ts: now(),
      ...(options.step ? { step: options.step } : {}),
      payload,
    } as AgentEvent;

    this.run.events.push(event);
    if (this.run.events.length > MAX_RETAINED_RUN_EVENTS) {
      this.run.events.splice(0, this.run.events.length - MAX_RETAINED_RUN_EVENTS);
    }
    this.onEvent?.(event);
    if (isPublicAgentEvent(event)) {
      const sse = `id: ${event.seq}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of this.run.clients) res.write(sse);
    }

    if (type === 'agent.done' || type === 'agent.error') {
      for (const res of this.run.clients) res.end();
      this.run.clients.clear();
    }

    return event;
  }
}
