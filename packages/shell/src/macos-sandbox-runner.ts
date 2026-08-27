import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ShellRequestError } from './errors.js';
import type { SandboxMode, SandboxRunner, SandboxSpawnSpec, ShellResult } from './types.js';

export interface MacSandboxRunnerOptions {
  helperPath?: string;
}

export interface MacSandboxAvailability {
  helperPath: string;
  version: string;
}

const EXPECTED_HELPER_VERSION = '0.1.0';

export class MacSandboxRunner implements SandboxRunner {
  private readonly helperPath: string;
  private availability?: Promise<MacSandboxAvailability>;

  constructor(options: MacSandboxRunnerOptions = {}) {
    this.helperPath = options.helperPath ?? defaultHelperPath();
  }

  supports(mode: SandboxMode) {
    return process.platform === 'darwin' && (mode === 'read-only' || mode === 'workspace-write');
  }

  checkAvailability() {
    this.availability ??= probeHelper(this.helperPath);
    return this.availability;
  }

  async spawn(spec: SandboxSpawnSpec) {
    if (!this.supports(spec.mode)) {
      throw new ShellRequestError('SANDBOX_UNAVAILABLE', `macOS sandbox does not support ${spec.mode}`);
    }
    if (spec.mode === 'workspace-write' && !spec.workspaceRoot) {
      throw new ShellRequestError('INVALID_REQUEST', 'workspaceRoot is required for workspace-write');
    }

    const availability = await this.checkAvailability();
    const cancelFile = path.join(tmpdir(), `moke-shell-cancel-${process.pid}-${randomUUID()}`);
    const args = [
      '--mode', spec.mode,
      '--cwd', spec.cwd,
      '--cancel-file', cancelFile,
      ...(spec.workspaceRoot ? ['--workspace', spec.workspaceRoot] : []),
      '--',
      '/bin/zsh',
      '-lc',
      spec.command,
    ];
    const child = spawn(availability.helperPath, args, { cwd: spec.cwd, env: spec.env });
    child.once('close', () => rmSync(cancelFile, { force: true }));

    return {
      child,
      terminate: () => writeFileSync(cancelFile, ''),
      enforcement: 'partial' as const,
      runner: 'macos-seatbelt',
      runnerVersion: availability.version,
      classifyFailure: classifyMacSandboxFailure,
    };
  }
}

function defaultHelperPath() {
  const configured = process.env.MOKE_MACOS_SANDBOX_HELPER;
  if (configured) return configured;
  const packaged = path.resolve(path.dirname(process.execPath), '..', 'shell', 'moke-macos-sandbox');
  if (existsSync(packaged)) return packaged;
  const developmentCandidates = [
    path.resolve(process.cwd(), 'packages/shell/native/macos-sandbox/target/release/moke-macos-sandbox'),
    path.resolve(process.cwd(), 'native/macos-sandbox/target/release/moke-macos-sandbox'),
  ];
  return developmentCandidates.find(existsSync) ?? developmentCandidates[0];
}

function probeHelper(helperPath: string): Promise<MacSandboxAvailability> {
  if (!existsSync(helperPath)) {
    return Promise.reject(new ShellRequestError('SANDBOX_UNAVAILABLE', `macOS sandbox helper was not found: ${helperPath}`));
  }
  return new Promise((resolve, reject) => {
    execFile(helperPath, ['--version'], { encoding: 'utf8', timeout: 5_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new ShellRequestError('SANDBOX_UNAVAILABLE', `macOS sandbox helper check failed: ${stderr.trim() || error.message}`));
        return;
      }
      const expected = `moke-macos-sandbox ${EXPECTED_HELPER_VERSION}`;
      if (stdout.trim() !== expected) {
        reject(new ShellRequestError('SANDBOX_UNAVAILABLE', `macOS sandbox helper version mismatch: expected ${expected}, received ${stdout.trim() || '(empty)'}`));
        return;
      }
      resolve({ helperPath, version: EXPECTED_HELPER_VERSION });
    });
  });
}

function classifyMacSandboxFailure(input: { exitCode: number | null; stderr: string }): ShellResult['error'] | undefined {
  if (input.exitCode === 127 && input.stderr.includes('moke-sandbox:')) {
    return { code: 'SANDBOX_UNAVAILABLE', message: input.stderr.trim() || 'macOS sandbox helper failed' };
  }
  if (input.exitCode !== 0 && /operation not permitted|permission denied|read-only file system/i.test(input.stderr)) {
    return { code: 'SANDBOX_DENIED', message: 'macOS sandbox denied a file operation' };
  }
  return undefined;
}
