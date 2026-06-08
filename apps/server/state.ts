import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Run, Session } from '../../packages/protocol/src/index.js';

type StoredRun = Omit<Run, 'clients'>;

type StoredState = {
  sessions: Session[];
  runs: StoredRun[];
};

type StateStoreInput = {
  statePath: string;
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
};

export function loadState({ statePath, sessions, runs }: StateStoreInput) {
  if (!existsSync(statePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<StoredState>;
    for (const session of parsed.sessions || []) {
      if (!session.id) continue;
      sessions.set(session.id, session);
    }

    for (const storedRun of parsed.runs || []) {
      if (!storedRun.id) continue;
      const status = ['queued', 'running', 'awaiting_user', 'awaiting_approval'].includes(storedRun.status)
        ? 'failed'
        : storedRun.status;
      runs.set(storedRun.id, {
        ...storedRun,
        status,
        abort: status === 'failed' ? true : storedRun.abort,
        pending_ask: undefined,
        clients: new Set(),
      });
    }
  } catch (error) {
    console.warn(`Failed to load state from ${statePath}:`, error);
  }
}

export function createStateSaver({ statePath, sessions, runs }: StateStoreInput) {
  let saveTimer: NodeJS.Timeout | undefined;

  function saveStateSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 80);
  }

  function saveState() {
    saveTimer = undefined;
    const state: StoredState = {
      sessions: [...sessions.values()],
      runs: [...runs.values()].map(({ clients, pending_ask, ...run }) => run),
    };

    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      console.warn(`Failed to save state to ${statePath}:`, error);
    }
  }

  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveState();
  }

  return {
    flush,
    saveStateSoon,
  };
}
