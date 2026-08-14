import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ShellExecutor } from '../src/shell-executor.js';
import { WindowsSandboxRunner } from '../src/windows-sandbox-runner.js';

const helperPath = fileURLToPath(new URL('../native/windows-sandbox/target/release/moke-windows-sandbox.exe', import.meta.url));
const canRun = process.platform === 'win32' && existsSync(helperPath);

test('Windows read-only can read but cannot write', { skip: !canRun }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'moke-shell-readonly-'));
  const source = path.join(workspace, 'source.txt');
  const blocked = path.join(workspace, 'blocked.txt');
  writeFileSync(source, 'readable');
  try {
    const executor = windowsExecutor();
    const read = await executor.run({
      command: `Get-Content -Raw -LiteralPath ${quotePowerShell(source)}`,
      workdir: workspace,
      sandbox: { mode: 'read-only' },
    });
    assert.equal(read.status, 'completed', read.stderr);
    assert.equal(read.stdout.trim(), 'readable');
    assert.equal(read.sandbox.enforcement, 'partial');
    assert.equal(read.sandbox.runner, 'windows-acl');
    assert.equal(read.sandbox.runnerVersion, '0.1.0');

    const write = await executor.run({
      command: `Set-Content -LiteralPath ${quotePowerShell(blocked)} -Value blocked`,
      workdir: workspace,
      sandbox: { mode: 'read-only' },
    });
    assert.equal(write.status, 'failed', write.stderr);
    assert.equal(write.error?.code, 'SANDBOX_DENIED', JSON.stringify(write));
    assert.equal(existsSync(blocked), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Windows sandbox preserves UTF-8 output without a console code-page process', { skip: !canRun }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'moke-shell-utf8-'));
  try {
    const result = await windowsExecutor().run({
      command: "Write-Output '\u4f60\u597d'",
      workdir: workspace,
      sandbox: { mode: 'read-only' },
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.stdout.trim(), '\u4f60\u597d');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Windows sandbox runner verifies the native helper version', { skip: !canRun }, async () => {
  const availability = await new WindowsSandboxRunner({ helperPath }).checkAvailability();
  assert.deepEqual(availability, { helperPath, version: '0.1.0' });
});

test('Windows sandbox runner fails closed when the helper is missing', { skip: process.platform !== 'win32' }, async () => {
  const missing = path.join(tmpdir(), `missing-moke-sandbox-${Date.now()}.exe`);
  const executor = new ShellExecutor({ runners: [new WindowsSandboxRunner({ helperPath: missing })] });
  const result = await executor.run({ command: 'Write-Output blocked', sandbox: { mode: 'read-only' } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'SANDBOX_UNAVAILABLE');
  assert.match(result.error?.message ?? '', /helper was not found/);
});

test('Windows workspace-write allows workspace writes and denies outside writes', { skip: !canRun }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'moke-shell-workspace-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moke-shell-outside-'));
  const allowed = path.join(workspace, 'allowed.txt');
  const blocked = path.join(outside, 'blocked.txt');
  try {
    const executor = windowsExecutor();
    const writeInside = await executor.run({
      command: `Set-Content -LiteralPath ${quotePowerShell(allowed)} -Value allowed`,
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(writeInside.status, 'completed', writeInside.stderr);
    assert.equal(readFileSync(allowed, 'utf8').trim(), 'allowed');
    assert.equal(writeInside.sandbox.enforcement, 'partial');

    const writeOutside = await executor.run({
      command: `Set-Content -LiteralPath ${quotePowerShell(blocked)} -Value blocked`,
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(writeOutside.status, 'failed', writeOutside.stderr);
    assert.equal(writeOutside.error?.code, 'SANDBOX_DENIED', JSON.stringify(writeOutside));
    assert.equal(existsSync(blocked), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Windows workspace-write blocks junction escapes', { skip: !canRun }, async (context) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'moke-shell-workspace-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moke-shell-outside-'));
  const link = path.join(workspace, 'link');
  const escaped = path.join(link, 'escaped.txt');
  try {
    try {
      symlinkSync(outside, link, 'junction');
    } catch (error) {
      context.skip(`junctions unavailable: ${String(error)}`);
      return;
    }
    const result = await windowsExecutor().run({
      command: `Set-Content -LiteralPath ${quotePowerShell(escaped)} -Value escaped`,
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

test('Windows sandbox restrictions are inherited by child processes', { skip: !canRun }, async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'moke-shell-workspace-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moke-shell-outside-'));
  const blocked = path.join(outside, 'child-blocked.txt');
  try {
    const nested = `Set-Content -LiteralPath ${quotePowerShell(blocked)} -Value blocked`;
    const result = await windowsExecutor().run({
      command: `& powershell.exe -NoLogo -NoProfile -NonInteractive -Command ${quotePowerShell(nested)}; exit $LASTEXITCODE`,
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(result.error?.code, 'SANDBOX_DENIED', JSON.stringify(result));
    assert.equal(existsSync(blocked), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function windowsExecutor() {
  return new ShellExecutor({ runners: [new WindowsSandboxRunner({ helperPath })] });
}

function quotePowerShell(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
