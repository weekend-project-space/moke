import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Session } from '../../../packages/protocol/src/index.js';

type StoredState = {
  sessions: Session[];
};

type StateStoreInput = {
  statePath: string;
  sessions: Map<string, Session>;
};

export function loadState({ statePath, sessions }: StateStoreInput) {
  if (!existsSync(statePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<StoredState>;
    for (const session of parsed.sessions || []) {
      if (!session.id) continue;
      sessions.set(session.id, session);
    }
  } catch (error) {
    console.warn(`Failed to load state from ${statePath}:`, error);
  }
}

export function createStateSaver({ statePath, sessions }: StateStoreInput) {
  let saveTimer: NodeJS.Timeout | undefined;

  function saveStateSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 80);
  }

  function saveState() {
    saveTimer = undefined;
    const state: StoredState = {
      sessions: [...sessions.values()],
    };
    const temporaryPath = `${statePath}.tmp`;

    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temporaryPath, statePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
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
