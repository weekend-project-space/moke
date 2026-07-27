import process from 'node:process';

import type { ApprovalMode, SessionEnvironment } from '@moke/protocol';

const MODES: ApprovalMode[] = ['manual', 'ai_review', 'auto_approve'];

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return typeof value === 'string' && MODES.includes(value as ApprovalMode) ? value as ApprovalMode : 'manual';
}

export function createSessionEnvironment(input: { workspace: string; approvalMode?: unknown }): SessionEnvironment {
  return {
    approval_mode: normalizeApprovalMode(input.approvalMode),
    system: {
      platform: normalizePlatform(process.platform),
      arch: process.arch,
      shell: resolveCurrentShell(),
    },
    workspace: { root: input.workspace },
  };
}

export function normalizeSessionEnvironment(value: unknown, workspace: string): SessionEnvironment {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return createSessionEnvironment({ workspace, approvalMode: source.approval_mode });
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
