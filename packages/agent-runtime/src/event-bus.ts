import { randomUUID } from 'node:crypto';

import type { AgentEvent, AgentEventPayloadMap, AgentEventType } from '../../protocol/src/index.js';
import type { RuntimeRun } from './run-state.js';

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

  emit<Type extends AgentEventType>(type: Type, payload: AgentEventPayloadMap[Type]) {
    const event: AgentEvent = {
      id: id('evt'),
      seq: ++this.run.seq,
      type,
      run_id: this.run.id,
      session_id: this.run.session_id,
      ts: now(),
      payload,
    } as AgentEvent;

    this.run.events.push(event);
    this.onEvent?.(event);
    const sse = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.run.clients) res.write(sse);

    if (type === 'agent.done' || type === 'agent.error') {
      for (const res of this.run.clients) res.end();
      this.run.clients.clear();
    }

    return event;
  }
}
