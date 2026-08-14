import process from 'node:process';
import path from 'node:path';

import type {
  ApprovalMode,
  CreateSessionEnvironmentInput,
  ModelSelection,
  ReasoningEffort,
  SendMessageEnvironmentInput,
  SessionEnvironment,
  UpdateSessionEnvironmentInput,
} from '@moke/protocol';

const MODES: ApprovalMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const REASONING_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max'];

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return typeof value === 'string' && MODES.includes(value as ApprovalMode) ? value as ApprovalMode : 'workspace-write';
}

export class SessionEnvironmentError extends Error {
  readonly code = 'INVALID_SESSION_ENVIRONMENT';
}

export function createSessionEnvironment(input: {
  defaultWorkspaceRoot: string;
  env?: CreateSessionEnvironmentInput;
}): SessionEnvironment {
  const model = normalizeModelSelection(input.env?.model);
  const reasoningEffort = normalizeReasoningEffort(input.env?.reasoningEffort);
  return {
    approval_mode: normalizeApprovalMode(input.env?.approval_mode),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
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
  const model = normalizeModelSelection(source.model);
  const reasoningEffort = normalizeReasoningEffort(source.reasoningEffort);
  return createSessionEnvironment({
    defaultWorkspaceRoot,
    env: {
      approval_mode: normalizeApprovalMode(source.approval_mode),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
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
  const next: SessionEnvironment = {
    ...baseline,
    approval_mode: input.approval_mode === undefined
      ? normalizeApprovalMode(baseline.approval_mode)
      : normalizeApprovalMode(input.approval_mode),
  };
  if (input.model === null) delete next.model;
  else if (input.model !== undefined) next.model = normalizeModelSelection(input.model);
  if (input.reasoningEffort === null) delete next.reasoningEffort;
  else if (input.reasoningEffort !== undefined) next.reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
  return next;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : undefined;
}

function normalizeModelSelection(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const providerId = typeof candidate.provider_id === 'string' ? candidate.provider_id.trim() : '';
  if (!providerId) return undefined;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  return { provider_id: providerId, ...(name ? { name } : {}) };
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
