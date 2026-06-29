import assert from 'node:assert/strict';
import test from 'node:test';

import type { Session } from '../../packages/protocol/src/index.js';
import { applySessionUpdate } from './session-update.js';

function createSession(): Session {
  return {
    id: 'sess_test',
    title: 'Original',
    created_at: '2026-06-27T00:00:00.000Z',
    updated_at: '2026-06-27T00:00:00.000Z',
    messages: [],
    metadata: { kept: true },
  };
}

test('applySessionUpdate renames a session with trimmed title', () => {
  const session = createSession();
  const result = applySessionUpdate(session, { title: '  Renamed  ' });

  assert.deepEqual(result, { ok: true, changed: true });
  assert.equal(session.title, 'Renamed');
  assert.deepEqual(session.metadata, { kept: true });
});

test('applySessionUpdate archives without removing existing metadata', () => {
  const session = createSession();
  const result = applySessionUpdate(session, { archived: true });

  assert.deepEqual(result, { ok: true, changed: true });
  assert.deepEqual(session.metadata, { kept: true, archived: true });
});

test('applySessionUpdate rejects empty title', () => {
  const session = createSession();
  const result = applySessionUpdate(session, { title: '  ' });

  assert.equal(result.ok, false);
  assert.equal(session.title, 'Original');
});

test('applySessionUpdate rejects empty input', () => {
  const session = createSession();
  const result = applySessionUpdate(session, {});

  assert.equal(result.ok, false);
});
