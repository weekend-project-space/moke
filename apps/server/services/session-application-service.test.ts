import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunManager } from '@moke/agent-runtime';
import type { Session } from '@moke/protocol';
import type { SessionRepository } from '../storage/session-store.js';
import { SessionApplicationService } from './session-application-service.js';

test('send rolls back the session environment and message when run creation fails', () => {
  const session: Session = {
    id: 'sess_1',
    title: 'New chat',
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
