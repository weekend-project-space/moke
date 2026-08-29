import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { SkillLoader, SkillRepository } from '@moke/agent-skills';
import type { SettingsService } from './settings-service.js';

export type WorkspaceEntry = { name: string; path: string };
export type WorkspaceContext = { id: string; root: string; expiresAt: number };

export class DiscoveryServiceError extends Error {
  constructor(readonly code: 'WORKSPACE_CONTEXT_NOT_FOUND' | 'WORKSPACE_PATH_INVALID', message: string) {
    super(message);
  }
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.moke', 'dist', 'build', '.next', '.turbo']);

export class DiscoveryService {
  private readonly contexts = new Map<string, WorkspaceContext>();

  constructor(
    private readonly settingsService: SettingsService,
    private readonly allowedRoots: () => string[] = () => [],
  ) {}

  createContext(root: string, ttlMs?: number) {
    if (!path.isAbsolute(root)) {
      throw new DiscoveryServiceError('WORKSPACE_PATH_INVALID', 'Workspace root must be an absolute path');
    }
    const resolved = path.resolve(root);
    const expiresAt = Date.now() + Math.min(Math.max(ttlMs || DEFAULT_TTL_MS, 1_000), MAX_TTL_MS);
    const context = { id: randomUUID(), root: resolved, expiresAt };
    this.contexts.set(context.id, context);
    return { id: context.id, root: context.root, expires_at: new Date(expiresAt).toISOString() };
  }

  resolveContext(contextId: string | undefined, sessionRoot: string | undefined, defaultRoot: string) {
    if (contextId) {
      const context = this.contexts.get(contextId);
      if (!context || context.expiresAt <= Date.now()) {
        this.contexts.delete(contextId);
        throw new DiscoveryServiceError('WORKSPACE_CONTEXT_NOT_FOUND', 'Workspace context not found or expired');
      }
      return context.root;
    }
    const root = path.resolve(sessionRoot || defaultRoot);
    // A Session's immutable workspace is already selected by the user and is
    // the authority for discovery within that Session. Draft contexts carry
    // the same authority temporarily through an opaque, expiring id.
    if (!sessionRoot) this.assertAllowedRoot(root);
    return root;
  }

  async listEntries(root: string, input: { path?: string; query?: string; includeDirectories?: boolean; limit?: number }) {
    const base = resolveInside(root, input.path || '');
    const query = (input.query || '').trim().toLowerCase();
    const limit = Math.min(Math.max(input.limit || 100, 1), 500);
    const results: WorkspaceEntry[] = [];
    await walk(base, root, query, input.includeDirectories !== false, results, limit);
    return results;
  }

  async listSkills(root: string, enabledOnly = true) {
    const skills = enabledOnly ? await new SkillLoader(root).list() : await new SkillRepository(root).listAll();
    return skills
      .filter((skill) => !enabledOnly || (skill as { enabled?: boolean }).enabled !== false)
      .map((skill) => ({ name: skill.name, description: skill.description }));
  }

  listModels(providerId?: string) {
    const settings = this.settingsService.get();
    const providers = settings.providers.filter((provider) => !providerId || provider.id === providerId);
    return providers.map((provider) => ({
      provider: provider.id,
      provider_name: provider.name,
      models: (provider.models || (provider.model ? [{ name: provider.model, alias: '' }] : [])).map((model) => ({
        name: model.name,
        ...(model.alias ? { alias: model.alias } : {}),
        supports_reasoning: provider.type === 'openai-responses' || provider.reasoningProvider === 'llama.cpp',
      })),
    }));
  }

  private assertAllowedRoot(root: string) {
    const configured = this.allowedRoots().map((item) => path.resolve(item));
    if (configured.length === 0 || configured.some((allowed) => isWithin(allowed, root))) return;
    throw new DiscoveryServiceError('WORKSPACE_PATH_INVALID', 'Workspace root is not authorized');
  }
}

async function walk(current: string, root: string, query: string, includeDirectories: boolean, results: WorkspaceEntry[], limit: number) {
  if (results.length >= limit) return;
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name) || results.length >= limit) continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute) || entry.name;
    if (!query || relative.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)) {
      if (entry.isFile() || includeDirectories) results.push({ name: entry.name, path: absolute });
    }
    if (entry.isDirectory()) await walk(absolute, root, query, includeDirectories, results, limit);
  }
}

function resolveInside(root: string, input: string) {
  const resolved = path.resolve(root, input);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DiscoveryServiceError('WORKSPACE_PATH_INVALID', 'Path is outside workspace');
  }
  return resolved;
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
