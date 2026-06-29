import assert from 'node:assert/strict';
import test from 'node:test';

import type { Session } from '../../../packages/protocol/src/index.js';
import { applySessionUpdate, forkSession } from './sessions.js';

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

test('forkSession copies messages through the selected message', () => {
  const source: Session = {
    id: 'sess_source',
    title: 'Source',
    created_at: '2026-06-27T00:00:00.000Z',
    updated_at: '2026-06-27T00:01:00.000Z',
    metadata: { theme: 'test' },
    messages: [
      {
        id: 'msg_1',
        role: 'user',
        content: 'first',
        created_at: '2026-06-27T00:00:01.000Z',
      },
      {
        id: 'msg_2',
        role: 'assistant',
        content: 'second',
        created_at: '2026-06-27T00:00:02.000Z',
      },
      {
        id: 'msg_3',
        role: 'user',
        content: 'third',
        created_at: '2026-06-27T00:00:03.000Z',
      },
    ],
  };

  const forked = forkSession({
    source,
    messageId: 'msg_2',
    now: '2026-06-27T00:02:00.000Z',
  });

  assert.ok(forked);
  assert.notEqual(forked.id, source.id);
  assert.deepEqual(
    forked.messages.map((message) => message.content),
    ['first', 'second'],
  );
  assert.notEqual(forked.messages[0].id, source.messages[0].id);
  assert.deepEqual(forked.metadata.forked_from, {
    session_id: 'sess_source',
    message_id: 'msg_2',
    message_index: 1,
    created_at: '2026-06-27T00:02:00.000Z',
  });
});

test('forkSession preserves cloned tool call links', () => {
  const source: Session = {
    id: 'sess_source',
    title: 'Source',
    created_at: '2026-06-27T00:00:00.000Z',
    updated_at: '2026-06-27T00:01:00.000Z',
    metadata: {},
    messages: [
      {
        id: 'msg_1',
        role: 'assistant',
        content: '',
        created_at: '2026-06-27T00:00:01.000Z',
        tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.md' } }],
      },
      {
        id: 'msg_2',
        role: 'tool',
        content: 'ok',
        created_at: '2026-06-27T00:00:02.000Z',
        tool_call_id: 'call_1',
        name: 'read_file',
      },
    ],
  };

  const forked = forkSession({
    source,
    messageId: 'msg_2',
    now: '2026-06-27T00:02:00.000Z',
  });

  assert.ok(forked);
  const assistant = forked.messages[0];
  const tool = forked.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.equal(tool.role, 'tool');
  assert.notEqual(assistant.tool_calls?.[0]?.id, 'call_1');
  assert.equal(tool.tool_call_id, assistant.tool_calls?.[0]?.id);
});

test('forkSession returns null when the message does not exist', () => {
  const source: Session = {
    id: 'sess_source',
    title: 'Source',
    created_at: '2026-06-27T00:00:00.000Z',
    updated_at: '2026-06-27T00:01:00.000Z',
    metadata: {},
    messages: [],
  };

  assert.equal(forkSession({ source, messageId: 'missing', now: '2026-06-27T00:02:00.000Z' }), null);
});
