import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MacSandboxRunner } from '../src/macos-sandbox-runner.js';
import { ShellExecutor } from '../src/shell-executor.js';

const helperPath = fileURLToPath(new URL('../native/macos-sandbox/target/release/moke-macos-sandbox', import.meta.url));
const canRun = process.platform === 'darwin' && existsSync(helperPath);

test('macOS read-only can read but cannot write', { skip: !canRun }, async () => {
  const workspace = createTempDirectory('moke-shell-readonly-');
  const source = path.join(workspace, 'source.txt');
  const blocked = path.join(workspace, 'blocked.txt');
  writeFileSync(source, 'readable');
  try {
    const read = await macosExecutor().run({
      command: `cat ${quoteShell(source)}`,
      workdir: workspace,
      sandbox: { mode: 'read-only' },
    });
    assert.equal(read.status, 'completed', read.stderr);
    assert.equal(read.stdout.trim(), 'readable');
    assert.equal(read.sandbox.enforcement, 'partial');
    assert.equal(read.sandbox.runner, 'macos-seatbelt');
    assert.equal(read.sandbox.runnerVersion, '0.1.0');

    const write = await macosExecutor().run({
      command: `printf blocked > ${quoteShell(blocked)}`,
      workdir: workspace,
      sandbox: { mode: 'read-only' },
    });
    assert.equal(write.status, 'failed', JSON.stringify(write));
    assert.equal(write.error?.code, 'SANDBOX_DENIED', JSON.stringify(write));
    assert.equal(existsSync(blocked), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('macOS sandbox runner verifies the native helper version', { skip: !canRun }, async () => {
  const availability = await new MacSandboxRunner({ helperPath }).checkAvailability();
  assert.deepEqual(availability, { helperPath, version: '0.1.0' });
});

test('macOS sandbox runner fails closed when the helper is missing', { skip: process.platform !== 'darwin' }, async () => {
  const missing = path.join(tmpdir(), `missing-moke-macos-sandbox-${Date.now()}`);
  const executor = new ShellExecutor({ runners: [new MacSandboxRunner({ helperPath: missing })] });
  const result = await executor.run({ command: 'echo blocked', sandbox: { mode: 'read-only' } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'SANDBOX_UNAVAILABLE');
  assert.match(result.error?.message ?? '', /helper was not found/);
});

test('macOS workspace-write allows workspace writes and denies outside writes', { skip: !canRun }, async () => {
  const workspace = createTempDirectory('moke-shell-workspace-');
  const outside = createTempDirectory('moke-shell-outside-');
  const allowed = path.join(workspace, 'allowed.txt');
  const blocked = path.join(outside, 'blocked.txt');
  try {
    const writeInside = await macosExecutor().run({
      command: `printf allowed > ${quoteShell(allowed)}`,
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(writeInside.status, 'completed', JSON.stringify(writeInside));
    assert.equal(readFileSync(allowed, 'utf8'), 'allowed');

    const writeOutside = await macosExecutor().run({
      command: `printf blocked > ${quoteShell(blocked)}`,
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(writeOutside.error?.code, 'SANDBOX_DENIED', JSON.stringify(writeOutside));
    assert.equal(existsSync(blocked), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('macOS workspace-write blocks symbolic-link escapes', { skip: !canRun }, async (context) => {
  const workspace = createTempDirectory('moke-shell-workspace-');
  const outside = createTempDirectory('moke-shell-outside-');
  const link = path.join(workspace, 'link');
  const escaped = path.join(link, 'escaped.txt');
  try {
    try {
      symlinkSync(outside, link, 'dir');
    } catch (error) {
      context.skip(`symbolic links unavailable: ${String(error)}`);
      return;
    }
    const result = await macosExecutor().run({
      command: `printf escaped > ${quoteShell(escaped)}`,
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(result.error?.code, 'SANDBOX_DENIED', JSON.stringify(result));
    assert.equal(existsSync(path.join(outside, 'escaped.txt')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function macosExecutor() {
  return new ShellExecutor({ runners: [new MacSandboxRunner({ helperPath })] });
}

function createTempDirectory(prefix: string) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}
