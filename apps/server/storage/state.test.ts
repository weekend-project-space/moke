import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Session } from '../../../packages/protocol/src/index.js';
import { createStateSaver, loadState } from './state.js';

test('state persistence writes sessions atomically without transient runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-state-'));
  const statePath = join(directory, 'state.json');
  const session: Session = {
    id: 'session_test',
    title: 'Test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    messages: [],
    metadata: {},
  };

  try {
    const sessions = new Map([[session.id, session]]);
    const saver = createStateSaver({ statePath, sessions });
    saver.saveStateSoon();
    saver.flush();

    const stored = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(stored, { sessions: [session] });

    session.title = 'Updated';
    saver.saveStateSoon();
    saver.flush();
    const updated = JSON.parse(readFileSync(statePath, 'utf8')) as { sessions: Session[] };
    assert.equal(updated.sessions[0]?.title, 'Updated');

    const loaded = new Map<string, Session>();
    loadState({ statePath, sessions: loaded });
    assert.deepEqual(loaded.get(session.id), session);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
