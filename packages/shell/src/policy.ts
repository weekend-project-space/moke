import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { ShellRequestError } from './errors.js';
import type { ShellRequest } from './types.js';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export interface ResolvedShellRequest extends Omit<ShellRequest, 'workdir' | 'timeoutMs' | 'maxOutputBytes' | 'sandbox'> {
  workdir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  sandbox: {
    mode: ShellRequest['sandbox']['mode'];
    workspaceRoot?: string;
  };
}

export async function resolveShellRequest(
  request: ShellRequest,
  defaults: { workdir?: string; timeoutMs?: number; maxTimeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ResolvedShellRequest> {
  if (typeof request.command !== 'string' || request.command.trim().length === 0) {
    throw new ShellRequestError('INVALID_REQUEST', 'command must be a non-empty string');
  }

  const timeoutMs = request.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = defaults.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxTimeoutMs) {
    throw new ShellRequestError('INVALID_REQUEST', `timeoutMs must be between 1 and ${maxTimeoutMs}`);
  }

  const maxOutputBytes = request.maxOutputBytes ?? defaults.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new ShellRequestError('INVALID_REQUEST', 'maxOutputBytes must be a positive integer');
  }

  const workdir = path.resolve(request.workdir ?? defaults.workdir ?? process.cwd());
  let workspaceRoot = request.sandbox.workspaceRoot;
  if (request.sandbox.mode === 'workspace-write') {
    if (!workspaceRoot) throw new ShellRequestError('INVALID_REQUEST', 'workspaceRoot is required for workspace-write');
    workspaceRoot = path.resolve(workspaceRoot);
    if (!(await isPathInside(workdir, workspaceRoot))) {
      throw new ShellRequestError('INVALID_REQUEST', 'workdir must be inside workspaceRoot for workspace-write');
    }
  } else if (workspaceRoot) {
    workspaceRoot = path.resolve(workspaceRoot);
  }

  return {
    ...request,
    workdir,
    timeoutMs,
    maxOutputBytes,
    sandbox: { mode: request.sandbox.mode, workspaceRoot },
  };
}

export async function isPathInside(candidate: string, root: string): Promise<boolean> {
  const [resolvedCandidate, resolvedRoot] = await Promise.all([resolveForCheck(candidate), resolveForCheck(root)]);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveForCheck(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    return path.join(await resolveForCheck(parent), path.basename(candidate));
  }
}
