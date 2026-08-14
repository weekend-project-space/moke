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
    approval_mode: 'workspace-write',
    workspace: { root: 'E:\\work\\project-a' },
  }, 'E:\\work\\default');

  assert.equal(environment.approval_mode, 'workspace-write');
  assert.equal(environment.workspace.root, path.resolve('E:\\work\\project-a'));
});


test('applyMutableSessionEnvironmentInput updates approval and preserves workspace', () => {
  const current = createSessionEnvironment({
    defaultWorkspaceRoot: 'E:\\work\\default',
    env: { approval_mode: 'read-only', workspace: { root: 'E:\\work\\project-a' } },
  });

  const approvalUpdate = applyMutableSessionEnvironmentInput(
    current,
    { approval_mode: 'danger-full-access' },
    'E:\\work\\default',
  );
  const unchangedUpdate = applyMutableSessionEnvironmentInput(
    approvalUpdate,
    {},
    'E:\\work\\default',
  );

  assert.equal(approvalUpdate.workspace.root, path.resolve('E:\\work\\project-a'));
  assert.equal(unchangedUpdate.approval_mode, 'danger-full-access');
  assert.equal(unchangedUpdate.workspace.root, path.resolve('E:\\work\\project-a'));
});

test('applyMutableSessionEnvironmentInput persists and clears a model selection', () => {
  const current = createSessionEnvironment({ defaultWorkspaceRoot: 'E:\\work\\default' });
  const selected = applyMutableSessionEnvironmentInput(current, {
    model: { provider_id: 'provider_openai', name: 'gpt-5' },
    reasoningEffort: 'high',
  }, 'E:\\work\\default');

  assert.deepEqual(selected.model, { provider_id: 'provider_openai', name: 'gpt-5' });
  assert.equal(selected.reasoningEffort, 'high');
  const restored = applyMutableSessionEnvironmentInput(selected, { model: null }, 'E:\\work\\default');
  assert.equal(restored.model, undefined);
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
