import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RunManager } from '@moke/agent-runtime';
import type { Session } from '@moke/protocol';
import type { SessionRepository } from '../storage/session-store.js';
import { SessionApplicationService } from './session-application-service.js';

test('createSession generates an isolated workspace when none is selected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-session-workspace-'));
  try {
    let saved: Session | undefined;
    const repository = { save(session: Session) { saved = session; } } as unknown as SessionRepository;
    const service = new SessionApplicationService(repository, {} as RunManager, root);
    const session = service.createSession({ title: 'New chat' });
    const created = new Date(session.created_at);
    const dateKey = [
      created.getFullYear(),
      String(created.getMonth() + 1).padStart(2, '0'),
      String(created.getDate()).padStart(2, '0'),
    ].join('-');
    const expected = path.join(root, '.moke', 'sessions', dateKey, session.id);

    assert.equal(session.env?.workspace.root, expected);
    assert.equal(session.metadata.generated_workspace, true);
    assert.equal(existsSync(expected), true);
    assert.equal(saved?.id, session.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createSession preserves a selected workspace', () => {
  const repository = { save() {} } as unknown as SessionRepository;
  const service = new SessionApplicationService(repository, {} as RunManager, 'E:\\work\\default');
  const session = service.createSession({
    title: 'Project chat',
    env: { workspace: { root: 'E:\\work\\project-a' } },
  });

  assert.equal(session.env?.workspace.root, path.resolve('E:\\work\\project-a'));
  assert.equal(session.metadata.generated_workspace, undefined);
});

test('send rolls back the session environment and message when run creation fails', () => {
  const session: Session = {
    id: 'sess_1',
    title: 'New chat',
    visibility: 'visible',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    messages: [],
    metadata: {},
    env: {
      approval_mode: 'manual',
      system: { platform: 'windows', arch: 'x64', shell: 'powershell.exe' },
      workspace: { root: 'E:\\work\\default' },
    },
  };
  const saved: Session[] = [];
  const repository = {
    save(value: Session) { saved.push(structuredClone(value)); },
  } as unknown as SessionRepository;
  const runManager = {
    createRun() { throw new Error('run unavailable'); },
  } as unknown as RunManager;
  const service = new SessionApplicationService(repository, runManager, 'E:\\work\\default');

  assert.throws(() => service.acceptUserMessage({
    session,
    content: 'review this project',
    env: {
      approval_mode: 'auto_approve',
    },
  }), /run unavailable/);

  assert.equal(session.title, 'New chat');
  assert.equal(session.env?.approval_mode, 'manual');
  assert.equal(session.env?.workspace.root, 'E:\\work\\default');
  assert.deepEqual(session.messages, []);
  assert.deepEqual(saved.at(-1), session);
});

test('send persists local file references and passes them to the run', () => {
  const session: Session = {
    id: 'sess_files',
    title: 'New chat',
    visibility: 'visible',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    messages: [],
    metadata: {},
    env: {
      approval_mode: 'manual',
      system: { platform: 'windows', arch: 'x64', shell: 'powershell.exe' },
      workspace: { root: 'E:\\work\\default' },
    },
  };
  let runInput: unknown;
  const repository = { save() {} } as unknown as SessionRepository;
  const runManager = {
    createRun(_session: Session, input: unknown) {
      runInput = input;
      return { id: 'run_files' };
    },
  } as unknown as RunManager;
  const service = new SessionApplicationService(repository, runManager, 'E:\\work\\default');
  const files = [{
    id: 'file_1',
    kind: 'file' as const,
    name: 'report.pdf',
    path: 'E:\\reports\\report.pdf',
    size: 120,
  }];

  service.acceptUserMessage({ session, content: 'Summarize this', files });

  assert.deepEqual(session.messages[0]?.role === 'user' ? session.messages[0].files : undefined, files);
  assert.deepEqual(runInput, { content: 'Summarize this', attachments: [], files });
});
