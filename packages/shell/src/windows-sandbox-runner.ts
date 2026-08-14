import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ShellRequestError } from './errors.js';
import type { SandboxMode, SandboxRunner, SandboxSpawnSpec, ShellResult } from './types.js';

export interface WindowsSandboxRunnerOptions {
  helperPath?: string;
}

export interface WindowsSandboxAvailability {
  helperPath: string;
  version: string;
}

const EXPECTED_HELPER_VERSION = '0.1.0';

export class WindowsSandboxRunner implements SandboxRunner {
  private readonly helperPath: string;
  private availability?: Promise<WindowsSandboxAvailability>;

  constructor(options: WindowsSandboxRunnerOptions = {}) {
    this.helperPath = options.helperPath ?? defaultHelperPath();
  }

  supports(mode: SandboxMode) {
    return process.platform === 'win32' && (mode === 'read-only' || mode === 'workspace-write');
  }

  checkAvailability() {
    this.availability ??= probeHelper(this.helperPath);
    return this.availability;
  }

  async spawn(spec: SandboxSpawnSpec) {
    if (!this.supports(spec.mode)) {
      throw new ShellRequestError('SANDBOX_UNAVAILABLE', `Windows sandbox does not support ${spec.mode}`);
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
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      withUtf8PowerShell(spec.command),
    ];
    const child = spawn(this.helperPath, args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
    });
    child.once('close', () => rmSync(cancelFile, { force: true }));

    return {
      child,
      terminate: () => writeFileSync(cancelFile, ''),
      enforcement: 'partial' as const,
      runner: 'windows-acl',
      runnerVersion: availability.version,
      classifyFailure: classifyWindowsSandboxFailure,
    };
  }
}

function defaultHelperPath() {
  const configured = process.env.MOKE_WINDOWS_SANDBOX_HELPER;
  if (configured) return configured;
  const packaged = path.resolve(path.dirname(process.execPath), '..', 'shell', 'moke-windows-sandbox.exe');
  if (existsSync(packaged)) return packaged;
  const developmentCandidates = [
    path.resolve(process.cwd(), 'packages/shell/native/windows-sandbox/target/release/moke-windows-sandbox.exe'),
    path.resolve(process.cwd(), 'native/windows-sandbox/target/release/moke-windows-sandbox.exe'),
  ];
  return developmentCandidates.find(existsSync) ?? developmentCandidates[0];
}

function probeHelper(helperPath: string): Promise<WindowsSandboxAvailability> {
  if (!existsSync(helperPath)) {
    return Promise.reject(new ShellRequestError('SANDBOX_UNAVAILABLE', `Windows sandbox helper was not found: ${helperPath}`));
  }
  return new Promise((resolve, reject) => {
    execFile(helperPath, ['--version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new ShellRequestError('SANDBOX_UNAVAILABLE', `Windows sandbox helper check failed: ${stderr.trim() || error.message}`));
        return;
      }
      const expected = `moke-windows-sandbox ${EXPECTED_HELPER_VERSION}`;
      if (stdout.trim() !== expected) {
        reject(new ShellRequestError('SANDBOX_UNAVAILABLE', `Windows sandbox helper version mismatch: expected ${expected}, received ${stdout.trim() || '(empty)'}`));
        return;
      }
      resolve({ helperPath, version: EXPECTED_HELPER_VERSION });
    });
  });
}

function classifyWindowsSandboxFailure(input: { exitCode: number | null; stderr: string }): ShellResult['error'] | undefined {
  if (input.exitCode === 127 && input.stderr.includes('moke-sandbox:')) {
    return {
      code: 'SANDBOX_UNAVAILABLE',
      message: input.stderr.trim() || 'Windows sandbox helper failed',
    };
  }
  if (input.exitCode !== 0 && isAccessDenied(input.stderr)) {
    return {
      code: 'SANDBOX_DENIED',
      message: 'Windows sandbox denied a file operation',
    };
  }
  return undefined;
}

function isAccessDenied(stderr: string) {
  return /access(?:\s+to\s+the\s+path.*?)?\s+is\s+denied|access denied|permission\s*denied|unauthorized\s*accessexception|unauthorizedaccesserror|0x80070005/i.test(stderr);
}

function withUtf8PowerShell(command: string) {
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    command,
  ].join('; ');
}
