import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Session } from '@moke/protocol';
import { summarizeSession } from '../domain/sessions.js';
import { JsonSessionStore } from './session-store.js';

function createSession(id: string, title = 'Test'): Session {
  return {
    id,
    title,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    messages: [],
    metadata: {},
  };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for session store');
}

test('session store writes only dirty sessions atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-session-store-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');
  const first = createSession('sess_first');
  const second = createSession('sess_second');

  try {
    const store = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    store.initialize();
    store.save(first);
    store.save(second);
    store.flush();

    const secondPath = join(storePath, 'sessions', 'sess_second.json');
    const originalSecond = readFileSync(secondPath, 'utf8');
    first.title = 'Updated';
    store.save(first);
    store.flush();

    assert.equal(JSON.parse(readFileSync(join(storePath, 'sessions', 'sess_first.json'), 'utf8')).title, 'Updated');
    assert.equal(readFileSync(secondPath, 'utf8'), originalSecond);
    assert.equal(existsSync(join(storePath, 'index.json')), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session store migrates legacy state and keeps a backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-session-migration-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');
  const sessions = [createSession('sess_first'), createSession('sess_second', 'Second')];

  try {
    writeFileSync(legacyStatePath, `${JSON.stringify({ sessions })}\n`);
    const store = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    store.initialize();
    assert.deepEqual(store.list().map(({ id }) => id), sessions.map(({ id }) => id));
    assert.deepEqual(store.get(sessions[0].id), sessions[0]);
    assert.equal(existsSync(legacyStatePath), false);
    assert.equal(existsSync(`${legacyStatePath}.bak`), true);
    assert.equal(existsSync(join(storePath, 'sessions', 'sess_first.json')), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session store skips a corrupted session file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-session-corrupt-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');

  try {
    const session = createSession('sess_valid');
    const firstStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    firstStore.initialize();
    firstStore.save(session);
    firstStore.flush();

    const secondStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    secondStore.initialize();
    writeFileSync(join(storePath, 'sessions', 'sess_valid.json'), '{broken');
    assert.equal(secondStore.list().length, 1);
    const previousWarn = console.warn;
    console.warn = () => undefined;
    try {
      assert.equal(secondStore.get('sess_valid'), undefined);
    } finally {
      console.warn = previousWarn;
    }
    assert.equal(secondStore.list().length, 0);
    assert.equal(readdirSync(join(storePath, 'sessions', '.corrupt')).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session store rebuilds the index when an unindexed session file appears', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-session-extra-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');

  try {
    const first = createSession('sess_first');
    const extra = createSession('sess_extra');
    const firstStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    firstStore.initialize();
    firstStore.save(first);
    firstStore.flush();
    writeFileSync(join(storePath, 'sessions', 'sess_extra.json'), `${JSON.stringify(extra)}\n`);

    const secondStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    secondStore.initialize();
    assert.deepEqual(new Set(secondStore.list().map(({ id }) => id)), new Set(['sess_first', 'sess_extra']));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session store rebuilds the index when a dirty marker remains', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-session-dirty-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');

  try {
    const session = createSession('sess_dirty');
    const firstStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    firstStore.initialize();
    firstStore.save(session);
    firstStore.flush();
    session.title = 'Recovered';
    writeFileSync(join(storePath, 'sessions', 'sess_dirty.json'), `${JSON.stringify(session)}\n`);
    writeFileSync(join(storePath, '.index-dirty'), 'interrupted\n');

    const secondStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    secondStore.initialize();
    assert.equal(secondStore.list()[0]?.title, 'Recovered');
    assert.equal(existsSync(join(storePath, '.index-dirty')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session store rebuilds the index when an indexed session file is missing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-session-missing-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');

  try {
    const session = createSession('sess_missing');
    const firstStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    firstStore.initialize();
    firstStore.save(session);
    firstStore.flush();
    rmSync(join(storePath, 'sessions', 'sess_missing.json'));

    const secondStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    secondStore.initialize();
    assert.deepEqual(secondStore.list(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session store retries a failed automatic flush', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-session-retry-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');
  const sessionsPath = join(storePath, 'sessions');
  const previousWarn = console.warn;
  let failedFlush = false;

  try {
    const store = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    store.initialize();
    console.warn = (...args: unknown[]) => {
      if (args[0] === 'Failed to flush session store:') failedFlush = true;
    };
    store.save(createSession('sess_retry'));
    writeFileSync(sessionsPath, 'temporarily blocked');

    await waitFor(() => failedFlush);
    rmSync(sessionsPath);
    await waitFor(() => existsSync(join(sessionsPath, 'sess_retry.json')));
    assert.equal(existsSync(join(storePath, '.index-dirty')), false);
  } finally {
    console.warn = previousWarn;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session store rebuilds a corrupted index from session files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-session-index-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');

  try {
    const session = createSession('sess_index');
    const firstStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    firstStore.initialize();
    firstStore.save(session);
    firstStore.flush();
    writeFileSync(join(storePath, 'index.json'), '{broken');

    const secondStore = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    const previousWarn = console.warn;
    console.warn = () => undefined;
    try {
      secondStore.initialize();
    } finally {
      console.warn = previousWarn;
    }
    assert.deepEqual(secondStore.list().map(({ id }) => id), ['sess_index']);
    assert.deepEqual(secondStore.get('sess_index'), session);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
