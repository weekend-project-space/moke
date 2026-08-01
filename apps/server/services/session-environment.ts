import process from 'node:process';
import path from 'node:path';

import type {
  ApprovalMode,
  CreateSessionEnvironmentInput,
  SendMessageEnvironmentInput,
  SessionEnvironment,
  UpdateSessionEnvironmentInput,
} from '@moke/protocol';

const MODES: ApprovalMode[] = ['manual', 'ai_review', 'auto_approve'];

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return typeof value === 'string' && MODES.includes(value as ApprovalMode) ? value as ApprovalMode : 'manual';
}

export class SessionEnvironmentError extends Error {
  readonly code = 'INVALID_SESSION_ENVIRONMENT';
}

export function createSessionEnvironment(input: {
  defaultWorkspaceRoot: string;
  env?: CreateSessionEnvironmentInput;
}): SessionEnvironment {
  return {
    approval_mode: normalizeApprovalMode(input.env?.approval_mode),
    system: {
      platform: normalizePlatform(process.platform),
      arch: process.arch,
      shell: resolveCurrentShell(),
    },
    workspace: { root: normalizeWorkspaceRoot(input.env?.workspace?.root, input.defaultWorkspaceRoot) },
  };
}

export function normalizeSessionEnvironment(value: unknown, defaultWorkspaceRoot: string): SessionEnvironment {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const workspace = source.workspace && typeof source.workspace === 'object'
    ? source.workspace as Record<string, unknown>
    : {};
  return createSessionEnvironment({
    defaultWorkspaceRoot,
    env: {
      approval_mode: normalizeApprovalMode(source.approval_mode),
      ...(typeof workspace.root === 'string' ? { workspace: { root: workspace.root } } : {}),
    },
  });
}

export function applyMutableSessionEnvironmentInput(
  current: SessionEnvironment | undefined,
  input: UpdateSessionEnvironmentInput | SendMessageEnvironmentInput,
  defaultWorkspaceRoot: string,
): SessionEnvironment {
  const baseline = current || createSessionEnvironment({ defaultWorkspaceRoot });
  return {
    ...baseline,
    approval_mode: input.approval_mode === undefined
      ? baseline.approval_mode
      : normalizeApprovalMode(input.approval_mode),
  };
}

function normalizeWorkspaceRoot(value: unknown, fallback: string) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const selected = raw || fallback;
  if (!path.isAbsolute(selected)) {
    throw new SessionEnvironmentError('workspace.root must be an absolute path');
  }
  return path.resolve(selected);
}

function normalizePlatform(platform: string): SessionEnvironment['system']['platform'] {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'other';
}

function resolveCurrentShell() {
  return process.env.ComSpec || process.env.SHELL || 'unknown';
}
