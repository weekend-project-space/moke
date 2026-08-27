import { spawn } from 'node:child_process';

import { ShellRequestError } from './errors.js';
import { LocalShellRunner } from './local-runner.js';
import { MacSandboxRunner } from './macos-sandbox-runner.js';
import { resolveShellRequest, type ResolvedShellRequest } from './policy.js';
import type { SandboxRunner, ShellErrorCode, ShellExecutorOptions, ShellRequest, ShellResult } from './types.js';
import { WindowsSandboxRunner } from './windows-sandbox-runner.js';

const DEFAULT_RUNNERS = [new WindowsSandboxRunner(), new MacSandboxRunner(), new LocalShellRunner()];

export class ShellExecutor {
  private readonly runners: SandboxRunner[];
  private readonly options: ShellExecutorOptions;

  constructor(options: ShellExecutorOptions = {}) {
    this.options = options;
    this.runners = options.runners ?? DEFAULT_RUNNERS;
  }

  async run(request: ShellRequest): Promise<ShellResult> {
    const startedAt = Date.now();
    let resolved: ResolvedShellRequest | undefined;
    try {
      resolved = await resolveShellRequest(request, this.options);
      const runner = this.runners.find((candidate) => candidate.supports(resolved!.sandbox.mode));
      if (!runner) throw new ShellRequestError('SANDBOX_UNAVAILABLE', `No sandbox runner is configured for ${resolved.sandbox.mode}`);

      const env = { ...process.env, ...resolved.env };
      const spawned = await runner.spawn({
        command: resolved.command,
        cwd: resolved.workdir,
        mode: resolved.sandbox.mode,
        workspaceRoot: resolved.sandbox.workspaceRoot,
        env,
      });
      return await collectResult(spawned, resolved, startedAt);
    } catch (error) {
      const normalized = normalizeError(error);
      return {
        status: normalized.code === 'TIMEOUT' ? 'timed_out' : normalized.code === 'ABORTED' ? 'aborted' : 'failed',
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: Date.now() - startedAt,
        sandbox: { mode: resolved?.sandbox.mode ?? request.sandbox.mode, enforced: false, enforcement: 'none', denied: false },
        error: normalized,
      };
    }
  }
}

async function collectResult(spawned: Awaited<ReturnType<SandboxRunner['spawn']>>, request: ResolvedShellRequest, startedAt: number): Promise<ShellResult> {
  const child = spawned.child;
  const stdout = new ByteCollector(request.maxOutputBytes);
  const stderr = new ByteCollector(request.maxOutputBytes);
  child.stdout?.on('data', (chunk: Buffer | string) => stdout.append(chunk));
  child.stderr?.on('data', (chunk: Buffer | string) => stderr.append(chunk));

  let timer: NodeJS.Timeout | undefined;
  let aborted = false;
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const abort = () => {
    aborted = true;
    terminate(spawned);
  };
  if (request.signal?.aborted) abort();
  else request.signal?.addEventListener('abort', abort, { once: true });
  const timeout = new Promise<'timed_out'>(resolve => {
    timer = setTimeout(() => { terminate(spawned); resolve('timed_out'); }, request.timeoutMs);
  });

  try {
    const outcome = await Promise.race([close.then(value => ({ kind: 'closed' as const, value })), timeout.then(kind => ({ kind }))]);
    if (outcome.kind === 'timed_out') {
      await close.catch(() => undefined);
      return result('timed_out', stdout, stderr, request, startedAt, spawned, { code: undefined, signal: undefined }, { code: 'TIMEOUT', message: `Command timed out after ${request.timeoutMs}ms` });
    }
    const failureInput = { exitCode: outcome.value.code, stderr: stderr.text() };
    const classifiedFailure = spawned.classifyFailure?.(failureInput);
    const denied = classifiedFailure?.code === 'SANDBOX_DENIED'
      || (spawned.classifyDenial?.(failureInput) ?? false);
    const status = aborted ? 'aborted' : outcome.value.code === 0 ? 'completed' : 'failed';
    const error = aborted
      ? { code: 'ABORTED' as const, message: 'Command was aborted' }
      : classifiedFailure ?? (denied
        ? { code: 'SANDBOX_DENIED' as const, message: `Sandbox denied the command under ${request.sandbox.mode}` }
        : undefined);
    return result(status, stdout, stderr, request, startedAt, spawned, outcome.value, error, denied);
  } catch (error) {
    const normalized = normalizeError(error, 'SPAWN_FAILED');
    return result('failed', stdout, stderr, request, startedAt, spawned, { code: undefined, signal: undefined }, normalized);
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
  }
}

function result(status: ShellResult['status'], stdout: ByteCollector, stderr: ByteCollector, request: ResolvedShellRequest, startedAt: number, spawned: Awaited<ReturnType<SandboxRunner['spawn']>>, exit: { code?: number | null; signal?: NodeJS.Signals | null }, error?: ShellResult['error'], denied = false): ShellResult {
  return {
    status,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    ...(exit.code !== undefined && exit.code !== null ? { exitCode: exit.code } : {}),
    ...(exit.signal ? { signal: exit.signal } : {}),
    durationMs: Date.now() - startedAt,
    sandbox: {
      mode: request.sandbox.mode,
      enforced: spawned.enforcement !== 'none',
      enforcement: spawned.enforcement,
      denied,
      runner: spawned.runner,
      ...(spawned.runnerVersion ? { runnerVersion: spawned.runnerVersion } : {}),
    },
    ...(error ? { error } : {}),
  };
}

class ByteCollector {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  append(chunk: Buffer | string) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.limit - this.size;
    if (remaining <= 0) { this.truncated = true; return; }
    this.chunks.push(data.subarray(0, remaining));
    this.size += Math.min(data.byteLength, remaining);
    if (data.byteLength > remaining) this.truncated = true;
  }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

function normalizeError(error: unknown, fallback: ShellErrorCode = 'INVALID_REQUEST'): NonNullable<ShellResult['error']> {
  if (error instanceof ShellRequestError) return { code: error.code, message: error.message };
  return { code: fallback, message: error instanceof Error ? error.message : String(error) };
}

function terminate(spawned: Awaited<ReturnType<SandboxRunner['spawn']>>) {
  try {
    if (spawned.terminate) spawned.terminate();
    else killProcessTree(spawned.child.pid);
  } catch {
    // The process may already have exited between the timer and termination.
  }
}

function killProcessTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
}
