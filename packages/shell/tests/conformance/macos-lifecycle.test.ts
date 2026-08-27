import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MacSandboxRunner } from '../../src/macos-sandbox-runner.js';
import { ShellExecutor } from '../../src/shell-executor.js';

const helperPath = fileURLToPath(new URL('../../native/macos-sandbox/target/release/moke-macos-sandbox', import.meta.url));
const canRun = process.platform === 'darwin' && existsSync(helperPath);

test('macOS timeout and cancellation kill the sandbox process group', { skip: !canRun }, async () => {
  await assertProcessTreeStopped('timeout');
  await assertProcessTreeStopped('abort');
});

test('macOS workspace-write removes its private temporary directory after exit', { skip: !canRun }, async () => {
  const workspace = createTempDirectory('moke-shell-temp-normal-');
  try {
    const result = await macosExecutor().run({
      command: 'printf "%s\\n" "$TMPDIR"; printf ok > "$TMPDIR/probe.txt"',
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

test('macOS helper cleans private temporary state when child startup fails', { skip: !canRun }, () => {
  const workspace = createTempDirectory('moke-shell-start-failure-');
  try {
    const result = spawnSync(helperPath, [
      '--mode', 'workspace-write',
      '--workspace', workspace,
      '--cwd', workspace,
      '--cancel-file', path.join(workspace, 'cancel'),
      '--',
      `missing-moke-command-${Date.now()}`,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 127, result.stderr);
    assert.match(result.stderr, /moke-sandbox:/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

async function assertProcessTreeStopped(kind: 'timeout' | 'abort') {
  const workspace = createTempDirectory(`moke-shell-${kind}-tree-`);
  const pidFile = path.join(workspace, 'child.pid');
  const childScript = path.join(workspace, 'child.cjs');
  writeFileSync(childScript, "require('node:fs').writeFileSync(process.env.MOKE_TEST_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);\n");
  let childPid = 0;
  try {
    const controller = new AbortController();
    const execution = macosExecutor().run({
      command: `${quoteShell(process.execPath)} ${quoteShell(childScript)}`,
      workdir: workspace,
      timeoutMs: kind === 'timeout' ? 2_500 : 10_000,
      signal: controller.signal,
      env: { MOKE_TEST_PID_FILE: pidFile },
      sandbox: { mode: 'workspace-write', workspaceRoot: workspace },
    });
    if (kind === 'abort') {
      await waitFor(() => existsSync(pidFile), 5_000);
      controller.abort();
    }
    const result = await execution;
    assert.equal(result.status, kind === 'timeout' ? 'timed_out' : 'aborted', JSON.stringify(result));
    assert.equal(existsSync(pidFile), true, JSON.stringify(result));
    childPid = Number(readFileSync(pidFile, 'utf8').trim());
    await waitFor(() => !isProcessAlive(childPid), 3_000);
    assert.equal(isProcessAlive(childPid), false, `child process ${childPid} survived ${kind}`);
  } finally {
    if (childPid && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL');
    rmSync(workspace, { recursive: true, force: true });
  }
}

function macosExecutor() {
  return new ShellExecutor({ runners: [new MacSandboxRunner({ helperPath })] });
}

function createTempDirectory(prefix: string) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function firstOutputLine(output: string) {
  return output.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
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
