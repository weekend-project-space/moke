import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ShellExecutor } from '../../src/shell-executor.js';
import { WindowsSandboxRunner } from '../../src/windows-sandbox-runner.js';

const helperPath = fileURLToPath(new URL('../../native/windows-sandbox/target/release/moke-windows-sandbox.exe', import.meta.url));
const canRun = process.platform === 'win32' && existsSync(helperPath);

test('Windows timeout kills the complete sandbox process tree', { skip: !canRun }, async () => {
  await assertProcessTreeStopped('timeout');
});

test('Windows cancellation kills the complete sandbox process tree', { skip: !canRun }, async () => {
  await assertProcessTreeStopped('abort');
});

test('Windows workspace-write removes its private temp directory after a normal exit', { skip: !canRun }, async () => {
  const workspace = createTempDirectory('moke-shell-temp-normal-');
  try {
    const result = await windowsExecutor().run({
      command: "Write-Output $env:TEMP; Set-Content -LiteralPath (Join-Path $env:TEMP 'probe.txt') -Value ok",
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const privateTemp = firstOutputLine(result.stdout);
    assert.notEqual(privateTemp, '');
    assert.equal(existsSync(privateTemp), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Windows timeout temp capability is not reused by a later sandbox', { skip: !canRun }, async () => {
  const workspace = createTempDirectory('moke-shell-temp-timeout-');
  let staleTemp = '';
  try {
    const timedOut = await windowsExecutor().run({
      command: 'Write-Output $env:TEMP; Start-Sleep -Seconds 60',
      workdir: workspace,
      timeoutMs: 750,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    assert.equal(timedOut.status, 'timed_out', JSON.stringify(timedOut));
    staleTemp = firstOutputLine(timedOut.stdout);
    assert.notEqual(staleTemp, '');

    if (existsSync(staleTemp)) {
      const retry = await windowsExecutor().run({
        command: `Write-Output $env:TEMP; Set-Content -LiteralPath ${quotePowerShell(path.join(staleTemp, 'reuse.txt'))} -Value blocked`,
        workdir: workspace,
        sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
      });
      assert.equal(retry.error?.code, 'SANDBOX_DENIED', JSON.stringify(retry));
      assert.notEqual(firstOutputLine(retry.stdout).toLowerCase(), staleTemp.toLowerCase());
      assert.equal(existsSync(path.join(staleTemp, 'reuse.txt')), false);
    }
  } finally {
    if (staleTemp && existsSync(staleTemp)) rmSync(staleTemp, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Windows concurrent workspace-write calls use isolated temp directories', { skip: !canRun }, async () => {
  const workspace = createTempDirectory('moke-shell-concurrent-');
  try {
    const executor = windowsExecutor();
    const run = (name: string) => executor.run({
      command: `Write-Output $env:TEMP; Start-Sleep -Milliseconds 400; Set-Content -LiteralPath ${quotePowerShell(path.join(workspace, name))} -Value ok`,
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    const [left, right] = await Promise.all([run('left.txt'), run('right.txt')]);
    assert.equal(left.status, 'completed', JSON.stringify(left));
    assert.equal(right.status, 'completed', JSON.stringify(right));
    const leftTemp = firstOutputLine(left.stdout);
    const rightTemp = firstOutputLine(right.stdout);
    assert.notEqual(leftTemp.toLowerCase(), rightTemp.toLowerCase());
    assert.equal(existsSync(leftTemp), false);
    assert.equal(existsSync(rightTemp), false);
    assert.equal(existsSync(path.join(workspace, 'left.txt')), true);
    assert.equal(existsSync(path.join(workspace, 'right.txt')), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Windows read-only stays read-only while workspace-write is active', { skip: !canRun }, async () => {
  const workspace = createTempDirectory('moke-shell-mixed-');
  const allowed = path.join(workspace, 'allowed.txt');
  const blocked = path.join(workspace, 'blocked.txt');
  try {
    const executor = windowsExecutor();
    const writable = executor.run({
      command: `Start-Sleep -Milliseconds 500; Set-Content -LiteralPath ${quotePowerShell(allowed)} -Value allowed`,
      workdir: workspace,
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const readOnly = await executor.run({
      command: `Set-Content -LiteralPath ${quotePowerShell(blocked)} -Value blocked`,
      workdir: workspace,
      sandbox: { mode: 'read-only' },
    });
    const writableResult = await writable;
    assert.equal(writableResult.status, 'completed', JSON.stringify(writableResult));
    assert.equal(readOnly.error?.code, 'SANDBOX_DENIED', JSON.stringify(readOnly));
    assert.equal(existsSync(allowed), true);
    assert.equal(existsSync(blocked), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Windows helper cleans private temp state when child startup fails', { skip: !canRun }, () => {
  const workspace = createTempDirectory('moke-shell-start-failure-');
  try {
    const before = sandboxTempDirectories();
    const result = spawnSync(helperPath, [
      '--mode', 'workspace-write',
      '--workspace', workspace,
      '--cwd', workspace,
      '--',
      `missing-moke-command-${Date.now()}.exe`,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 127, result.stderr);
    assert.match(result.stderr, /moke-sandbox:/);
    assert.deepEqual(sandboxTempDirectories(), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Windows repeated workspace grants keep one stable capability ACE', { skip: !canRun }, async () => {
  const workspace = createTempDirectory('moke-shell-stable-acl-');
  try {
    const executor = windowsExecutor();
    for (let index = 0; index < 3; index++) {
      const result = await executor.run({
        command: 'Write-Output ok',
        workdir: workspace,
        sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
      });
      assert.equal(result.status, 'completed', JSON.stringify(result));
    }
    const acl = spawnSync('icacls.exe', [workspace], { encoding: 'utf8', windowsHide: true });
    assert.equal(acl.status, 0, acl.stderr);
    const capabilityAces = acl.stdout.match(/S-1-4-(?:\d+-){3}\d+/g) ?? [];
    assert.equal(new Set(capabilityAces).size, 1, acl.stdout);
    assert.equal(capabilityAces.length, 1, acl.stdout);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

async function assertProcessTreeStopped(kind: 'timeout' | 'abort') {
  const workspace = createTempDirectory(`moke-shell-${kind}-tree-`);
  const pidFile = path.join(workspace, 'child.pid');
  const tempPathFile = path.join(workspace, 'temp.path');
  const childScriptFile = path.join(workspace, 'child.cjs');
  writeFileSync(childScriptFile, "require('node:fs').writeFileSync(process.env.MOKE_TEST_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);\r\n");
  let childPid = 0;
  let privateTemp = '';
  try {
    const controller = new AbortController();
    const execution = windowsExecutor().run({
      command: [
        `Set-Content -LiteralPath ${quotePowerShell(tempPathFile)} -Value $env:TEMP`,
        `& ${quotePowerShell(process.execPath)} ${quotePowerShell(childScriptFile)}`,
      ].join('; '),
      workdir: workspace,
      timeoutMs: kind === 'timeout' ? 2_500 : 10_000,
      signal: controller.signal,
      env: { MOKE_TEST_PID_FILE: pidFile },
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    if (kind === 'abort') {
      await waitFor(() => existsSync(pidFile), 5_000);
      if (!existsSync(pidFile)) {
        controller.abort();
        await execution;
        assert.fail('sandbox child did not start before cancellation');
      }
      controller.abort();
    }
    const result = await execution;
    assert.equal(result.status, kind === 'timeout' ? 'timed_out' : 'aborted', JSON.stringify(result));
    assert.equal(existsSync(pidFile), true, JSON.stringify(result));
    childPid = Number(readFileSync(pidFile, 'utf8').trim());
    privateTemp = readFileSync(tempPathFile, 'utf8').trim();
    assert.equal(Number.isInteger(childPid) && childPid > 0, true);
    await waitFor(() => !isProcessAlive(childPid), 3_000);
    assert.equal(isProcessAlive(childPid), false, `child process ${childPid} survived ${kind}`);
  } finally {
    if (childPid && isProcessAlive(childPid)) spawnSync('taskkill.exe', ['/pid', String(childPid), '/t', '/f'], { windowsHide: true });
    if (privateTemp && existsSync(privateTemp)) rmSync(privateTemp, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

function windowsExecutor() {
  return new ShellExecutor({ runners: [new WindowsSandboxRunner({ helperPath })] });
}

function createTempDirectory(prefix: string) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function firstOutputLine(output: string) {
  return output.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function quotePowerShell(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sandboxTempDirectories() {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('moke-sandbox-'))
    .map((entry) => entry.name)
    .sort();
}
