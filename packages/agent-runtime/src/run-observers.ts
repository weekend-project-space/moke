import type { AgentEvent, RunLifecycleEvent, RunStatus } from '@moke/protocol';

import type { RuntimeRun } from './run-state.js';

export class RunObservers {
  private readonly eventObservers = new Set<(event: AgentEvent, run: RuntimeRun) => void>();
  private readonly lifecycleObservers = new Set<(event: RunLifecycleEvent) => void>();

  addEventObserver(observer: (event: AgentEvent, run: RuntimeRun) => void) {
    this.eventObservers.add(observer);
    return () => this.eventObservers.delete(observer);
  }

  addLifecycleObserver(observer: (event: RunLifecycleEvent) => void) {
    this.lifecycleObservers.add(observer);
    return () => this.lifecycleObservers.delete(observer);
  }

  notify(event: AgentEvent, run: RuntimeRun) {
    for (const observer of this.eventObservers) {
      try {
        observer(event, run);
      } catch (error) {
        console.error(`Run observer failed for ${run.id}`, error);
      }
    }
  }

  notifyStatus(run: RuntimeRun, status: RunStatus) {
    if (run.status === status) return false;
    run.status = status;
    const event: RunLifecycleEvent = {
      type: status,
      sessionId: run.session_id,
      runId: run.id,
    };
    for (const observer of this.lifecycleObservers) {
      try {
        observer(event);
      } catch (error) {
        console.error(`Run lifecycle observer failed for ${run.id}`, error);
      }
    }
    return true;
  }

  notifyInitial(run: RuntimeRun) {
    const event: RunLifecycleEvent = {
      type: run.status,
      sessionId: run.session_id,
      runId: run.id,
    };
    for (const observer of this.lifecycleObservers) {
      try {
        observer(event);
      } catch (error) {
        console.error(`Run lifecycle observer failed for ${run.id}`, error);
      }
    }
  }
}
