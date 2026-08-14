import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { LocalShellRunner } from '../src/local-runner.js';
import { ShellExecutor } from '../src/shell-executor.js';
import type { SandboxMode, SandboxRunner, SandboxSpawnSpec } from '../src/types.js';

test('confined modes fail closed when no sandbox runner is configured', async () => {
  const executor = new ShellExecutor({ runners: [new LocalShellRunner()] });
  const result = await executor.run({ command: 'echo should-not-run', sandbox: { mode: 'read-only' } });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'SANDBOX_UNAVAILABLE');
  assert.equal(result.sandbox.enforced, false);
  assert.equal(result.sandbox.enforcement, 'none');
});

test('danger-full-access executes through the local runner', async () => {
  const executor = new ShellExecutor();
  const command = process.platform === 'win32' ? "[Console]::Write('ok')" : "printf 'ok'";
  const result = await executor.run({ command, sandbox: { mode: 'danger-full-access' } });

  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.sandbox.enforced, false);
  assert.equal(result.sandbox.enforcement, 'none');
});

test('executor bounds captured output', async () => {
  const executor = new ShellExecutor({ runners: [new NodeScriptRunner(['danger-full-access'], "process.stdout.write('abcdefghij')")] });
  const result = await executor.run({
    command: 'ignored',
    maxOutputBytes: 4,
    sandbox: { mode: 'danger-full-access' },
  });

  assert.equal(result.stdout, 'abcd');
  assert.equal(result.stdoutTruncated, true);
});

test('runner can report a sandbox denial as a structured result', async () => {
  const executor = new ShellExecutor({ runners: [new NodeScriptRunner(['read-only'], "process.stderr.write('denied'); process.exit(1)", true)] });
  const result = await executor.run({ command: 'ignored', sandbox: { mode: 'read-only' } });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'SANDBOX_DENIED');
  assert.equal(result.sandbox.enforced, true);
  assert.equal(result.sandbox.denied, true);
});

test('executor times out and terminates a long-running process', async () => {
  const executor = new ShellExecutor({ runners: [new NodeScriptRunner(['danger-full-access'], 'setInterval(() => {}, 1000)')] });
  const result = await executor.run({ command: 'ignored', timeoutMs: 25, sandbox: { mode: 'danger-full-access' } });

  assert.equal(result.status, 'timed_out');
  assert.equal(result.error?.code, 'TIMEOUT');
});

test('executor uses runner-specific termination when provided', async () => {
  let terminations = 0;
  const executor = new ShellExecutor({
    runners: [new NodeScriptRunner(
      ['read-only'],
      'setInterval(() => {}, 1000)',
      false,
      () => { terminations += 1; },
    )],
  });
  const result = await executor.run({ command: 'ignored', timeoutMs: 25, sandbox: { mode: 'read-only' } });

  assert.equal(result.status, 'timed_out');
  assert.equal(terminations, 1);
});

class NodeScriptRunner implements SandboxRunner {
  constructor(
    private readonly modes: SandboxMode[],
    private readonly script: string,
    private readonly denied = false,
    private readonly onTerminate?: () => void,
  ) {}

  supports(mode: SandboxMode) {
    return this.modes.includes(mode);
  }

  async spawn(spec: SandboxSpawnSpec) {
    const child = spawn(process.execPath, ['-e', this.script], {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    return {
      child,
      ...(this.onTerminate ? {
        terminate: () => {
          this.onTerminate?.();
          child.kill();
        },
      } : {}),
      enforcement: spec.mode !== 'danger-full-access' ? 'full' as const : 'none' as const,
      runner: 'test',
      classifyDenial: () => this.denied,
    };
  }
}
