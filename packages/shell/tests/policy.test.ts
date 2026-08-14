import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveShellRequest } from '../src/policy.js';

test('workspace-write requires a workspace root', async () => {
  await assert.rejects(
    () => resolveShellRequest({ command: 'echo ok', sandbox: { mode: 'workspace-write' } }),
    /workspaceRoot is required/,
  );
});

test('workspace-write requires workdir to stay inside workspace root', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'moke-shell-workspace-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moke-shell-outside-'));
  try {
    await assert.rejects(
      () => resolveShellRequest({
        command: 'echo ok',
        workdir: outside,
        sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
      }),
      /workdir must be inside workspaceRoot/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('workspace-write resolves and accepts a workdir inside workspace root', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'moke-shell-workspace-'));
  const child = path.join(workspace, 'child');
  mkdirSync(child);
  try {
    const resolved = await resolveShellRequest({
      command: 'echo ok',
      workdir: child,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(resolved.workdir, path.resolve(child));
    assert.equal(resolved.sandbox.workspaceRoot, path.resolve(workspace));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('workspace-write rejects a junction or symlink that escapes the workspace', async (context) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'moke-shell-workspace-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moke-shell-outside-'));
  const link = path.join(workspace, 'link');
  try {
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      context.skip(`symlinks unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(
      () => resolveShellRequest({
        command: 'echo ok',
        workdir: link,
        sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
      }),
      /workdir must be inside workspaceRoot/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
