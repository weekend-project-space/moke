import type { ChildProcess } from 'node:child_process';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ShellResultStatus = 'completed' | 'failed' | 'timed_out' | 'aborted';

export type ShellErrorCode =
  | 'INVALID_REQUEST'
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_DENIED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'SPAWN_FAILED';

export interface SandboxPolicy {
  mode: SandboxMode;
  workspaceRoot?: string;
}

export interface ShellRequest {
  command: string;
  workdir?: string;
  sandbox: SandboxPolicy;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

export interface ShellResult {
  status: ShellResultStatus;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals;
  durationMs: number;
  sandbox: {
    mode: SandboxMode;
    enforced: boolean;
    enforcement: 'full' | 'partial' | 'none';
    denied: boolean;
    runner?: string;
    runnerVersion?: string;
  };
  error?: {
    code: ShellErrorCode;
    message: string;
  };
}

export interface SandboxSpawnSpec {
  command: string;
  cwd: string;
  mode: SandboxMode;
  workspaceRoot?: string;
  env: NodeJS.ProcessEnv;
}

export interface SandboxSpawnedProcess {
  child: ChildProcess;
  /** Runner-specific termination for process containers such as Windows Job Objects. */
  terminate?: () => void;
  enforcement: 'full' | 'partial' | 'none';
  runner: string;
  runnerVersion?: string;
  classifyDenial?: (input: { exitCode: number | null; stderr: string }) => boolean;
  classifyFailure?: (input: { exitCode: number | null; stderr: string }) => ShellResult['error'] | undefined;
}

export interface SandboxRunner {
  supports(mode: SandboxMode): boolean;
  spawn(spec: SandboxSpawnSpec): Promise<SandboxSpawnedProcess>;
}

export interface ShellExecutorOptions {
  runners?: SandboxRunner[];
  defaultWorkdir?: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
}
