import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  applyMutableSessionEnvironmentInput,
  createSessionEnvironment,
  normalizeSessionEnvironment,
  SessionEnvironmentError,
} from './session-environment.js';

test('normalizeSessionEnvironment preserves a persisted workspace root', () => {
  const environment = normalizeSessionEnvironment({
    approval_mode: 'ai_review',
    workspace: { root: 'E:\\work\\project-a' },
  }, 'E:\\work\\default');

  assert.equal(environment.approval_mode, 'ai_review');
  assert.equal(environment.workspace.root, path.resolve('E:\\work\\project-a'));
});

test('applyMutableSessionEnvironmentInput updates approval and preserves workspace', () => {
  const current = createSessionEnvironment({
    defaultWorkspaceRoot: 'E:\\work\\default',
    env: { approval_mode: 'manual', workspace: { root: 'E:\\work\\project-a' } },
  });

  const approvalUpdate = applyMutableSessionEnvironmentInput(
    current,
    { approval_mode: 'auto_approve' },
    'E:\\work\\default',
  );
  const unchangedUpdate = applyMutableSessionEnvironmentInput(
    approvalUpdate,
    {},
    'E:\\work\\default',
  );

  assert.equal(approvalUpdate.workspace.root, path.resolve('E:\\work\\project-a'));
  assert.equal(unchangedUpdate.approval_mode, 'auto_approve');
  assert.equal(unchangedUpdate.workspace.root, path.resolve('E:\\work\\project-a'));
});

test('session environment rejects a relative workspace root', () => {
  assert.throws(
    () => createSessionEnvironment({
      defaultWorkspaceRoot: 'E:\\work\\default',
      env: { workspace: { root: '..\\project-a' } },
    }),
    SessionEnvironmentError,
  );
});
