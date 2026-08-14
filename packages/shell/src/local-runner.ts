import { spawn } from 'node:child_process';

import { ShellRequestError } from './errors.js';
import type { SandboxRunner, SandboxSpawnSpec, SandboxSpawnedProcess, SandboxMode } from './types.js';

/** Local execution is intentionally available only for the explicit full-access mode. */
export class LocalShellRunner implements SandboxRunner {
  supports(mode: SandboxMode) {
    return mode === 'danger-full-access';
  }

  async spawn(spec: SandboxSpawnSpec): Promise<SandboxSpawnedProcess> {
    if (!this.supports(spec.mode)) {
      throw new ShellRequestError('SANDBOX_UNAVAILABLE', `No local sandbox runner is configured for ${spec.mode}`);
    }

    const isWindows = process.platform === 'win32';
    const child = isWindows
      ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', spec.command], {
          cwd: spec.cwd,
          env: spec.env,
          windowsHide: true,
        })
      : spawn('/bin/sh', ['-c', spec.command], {
          cwd: spec.cwd,
          env: spec.env,
          detached: true,
        });

    return { child, enforcement: 'none', runner: 'local' };
  }
}
