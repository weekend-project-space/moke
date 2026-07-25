import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseSkillFile, serializeSkillFile } from './skill-file.js';
import type { LoadedSkill, ManagedSkill, SkillDraft, SkillManifest } from './skill-types.js';

const DEFAULT_SKILL_DIR = '.moke/skills';
const DEFAULT_SKILL_REGISTRY = '.moke/skills.json';
const SKILL_FILE = 'SKILL.md';
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type SkillRegistry = {
  disabled: string[];
};

export class SkillRepositoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class SkillRepository {
  readonly root: string;
  readonly skillsDir: string;
  readonly registryPath: string;

  constructor(root: string, skillsDir = DEFAULT_SKILL_DIR, registryPath = DEFAULT_SKILL_REGISTRY) {
    this.root = path.resolve(root);
    this.skillsDir = resolveWorkspacePath(this.root, skillsDir, 'Skill directory');
    this.registryPath = resolveWorkspacePath(this.root, registryPath, 'Skill registry');
  }

  async listAll(): Promise<ManagedSkill[]> {
    const entries = await safeReadDir(this.skillsDir);
    const registry = await this.readRegistry();
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readManagedSkill(entry.name, registry.disabled.includes(entry.name))),
    );
    const names = new Map<string, number>();
    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      names.set(key, (names.get(key) || 0) + 1);
    }
    for (const skill of skills) {
      if ((names.get(skill.name.toLowerCase()) || 0) > 1) {
        skill.valid = false;
        skill.error = `Duplicate skill name: ${skill.name}`;
      }
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name));
  }

  async listEnabled(): Promise<SkillManifest[]> {
    return (await this.listAll())
      .filter((skill) => skill.enabled && skill.valid)
      .map(({ id, name, description, path: skillPath, enabled }) => ({
        id,
        name,
        description,
        path: skillPath,
        enabled,
      }));
  }

  async readEnabled(nameOrId: string): Promise<LoadedSkill> {
    const skill = (await this.listEnabled()).find((item) => item.id === nameOrId || item.name === nameOrId);
    if (!skill) throw new SkillRepositoryError('SKILL_NOT_FOUND', `Skill not found: ${nameOrId}`);
    const raw = await readFile(this.skillFile(skill.id), 'utf8');
    const parsed = parseSkillFile(raw, skill.id);
    return { ...skill, content: parsed.content };
  }

  async get(id: string): Promise<ManagedSkill & { content: string }> {
    this.assertId(id);
    const skills = await this.listAll();
    const summary = skills.find((skill) => skill.id === id);
    if (!summary) throw new SkillRepositoryError('SKILL_NOT_FOUND', `Skill not found: ${id}`);
    let raw = '';
    try {
      raw = await readFile(this.skillFile(id), 'utf8');
    } catch {
      // Missing files remain repairable from the settings editor.
    }
    let content = raw.trim();
    try {
      content = parseSkillFile(raw, id).content;
    } catch {
      // Keep malformed content visible so it can be replaced or the skill can be removed.
    }
    return { ...summary, content };
  }

  async create(draft: SkillDraft) {
    const normalized = this.normalizeDraft(draft);
    await this.assertUniqueName(normalized.name);
    const directory = this.skillDirectory(normalized.id);
    if (await exists(directory)) throw new SkillRepositoryError('SKILL_EXISTS', `Skill already exists: ${normalized.id}`);

    await mkdir(this.skillsDir, { recursive: true });
    await mkdir(directory, { recursive: false });
    try {
      await writeAtomic(this.skillFile(normalized.id), serializeSkillFile({ ...normalized, metadata: {} }));
      await this.setEnabled(normalized.id, normalized.enabled);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return this.get(normalized.id);
  }

  async update(id: string, draft: Omit<SkillDraft, 'id'>) {
    this.assertId(id);
    const current = await this.get(id);
    const normalized = this.normalizeDraft({ ...draft, id });
    await this.assertUniqueName(normalized.name, id);
    let metadata: Record<string, unknown> = {};
    try {
      metadata = parseSkillFile(await readFile(this.skillFile(id), 'utf8'), id).metadata;
    } catch {
      // Replacing malformed content with a valid document intentionally drops invalid metadata.
    }
    await writeAtomic(this.skillFile(id), serializeSkillFile({ ...normalized, metadata }));
    await this.setEnabled(id, normalized.enabled);
    return { ...current, ...(await this.get(id)) };
  }

  async remove(id: string) {
    this.assertId(id);
    const directory = this.skillDirectory(id);
    if (!(await exists(directory))) throw new SkillRepositoryError('SKILL_NOT_FOUND', `Skill not found: ${id}`);
    await rm(directory, { recursive: true, force: false });
    const registry = await this.readRegistry();
    registry.disabled = registry.disabled.filter((item) => item !== id);
    await this.writeRegistry(registry);
  }

  async setEnabled(id: string, enabled: boolean) {
    this.assertId(id);
    if (!(await exists(this.skillFile(id)))) throw new SkillRepositoryError('SKILL_NOT_FOUND', `Skill not found: ${id}`);
    const registry = await this.readRegistry();
    const disabled = new Set(registry.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    await this.writeRegistry({ disabled: [...disabled].sort() });
  }

  async validate(draft: SkillDraft, excludeId?: string) {
    const errors: string[] = [];
    let normalized: SkillDraft | undefined;
    try {
      normalized = this.normalizeDraft(draft);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Invalid skill');
    }
    if (normalized) {
      try {
        await this.assertUniqueName(normalized.name, excludeId);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Duplicate skill name');
      }
    }
    return { valid: errors.length === 0, errors };
  }

  private async readManagedSkill(id: string, disabled: boolean): Promise<ManagedSkill> {
    const skillPath = this.skillFile(id);
    const relativePath = path.relative(this.root, skillPath);
    try {
      const [raw, info] = await Promise.all([readFile(skillPath, 'utf8'), stat(skillPath)]);
      const parsed = parseSkillFile(raw, id);
      const errors = validateValues(id, parsed.name, parsed.description, parsed.content);
      return {
        id,
        name: parsed.name || id,
        description: parsed.description,
        path: relativePath,
        enabled: !disabled,
        valid: errors.length === 0,
        ...(errors.length > 0 ? { error: errors[0] } : {}),
        updatedAt: info.mtime.toISOString(),
      };
    } catch (error) {
      return {
        id,
        name: id,
        description: '',
        path: relativePath,
        enabled: !disabled,
        valid: false,
        error: error instanceof Error ? error.message : 'Unable to read skill',
        updatedAt: '',
      };
    }
  }

  private normalizeDraft(draft: SkillDraft): SkillDraft {
    const normalized = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      content: draft.content.trim(),
      enabled: Boolean(draft.enabled),
    };
    const errors = validateValues(normalized.id, normalized.name, normalized.description, normalized.content);
    if (errors.length > 0) throw new SkillRepositoryError('SKILL_INVALID', errors[0]);
    return normalized;
  }

  private async assertUniqueName(name: string, excludeId?: string) {
    const duplicate = (await this.listAll()).find(
      (skill) => skill.id !== excludeId && skill.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) throw new SkillRepositoryError('SKILL_NAME_EXISTS', `Skill name already exists: ${name}`);
  }

  private assertId(id: string) {
    if (!SKILL_ID_PATTERN.test(id)) {
      throw new SkillRepositoryError('SKILL_ID_INVALID', 'Skill ID must use lowercase letters, numbers, underscores, or hyphens');
    }
  }

  private skillDirectory(id: string) {
    this.assertId(id);
    const directory = path.resolve(this.skillsDir, id);
    if (path.dirname(directory) !== this.skillsDir) {
      throw new SkillRepositoryError('SKILL_ID_INVALID', 'Skill path is outside the skill directory');
    }
    return directory;
  }

  private skillFile(id: string) {
    return path.join(this.skillDirectory(id), SKILL_FILE);
  }

  private async readRegistry(): Promise<SkillRegistry> {
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as Partial<SkillRegistry>;
      return {
        disabled: Array.isArray(parsed.disabled)
          ? parsed.disabled.filter((item): item is string => typeof item === 'string' && SKILL_ID_PATTERN.test(item))
          : [],
      };
    } catch {
      return { disabled: [] };
    }
  }

  private async writeRegistry(registry: SkillRegistry) {
    await writeAtomic(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }
}

function validateValues(id: string, name: string, description: string, content: string) {
  const errors: string[] = [];
  if (!SKILL_ID_PATTERN.test(id)) errors.push('Skill ID must use lowercase letters, numbers, underscores, or hyphens');
  if (!name) errors.push('Skill name is required');
  else if (name.length > 80) errors.push('Skill name must be 80 characters or fewer');
  if (!description) errors.push('Skill description is required');
  else if (description.length > 500) errors.push('Skill description must be 500 characters or fewer');
  if (!content) errors.push('Skill instructions are required');
  return errors;
}

async function safeReadDir(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function exists(target: string) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function resolveWorkspacePath(root: string, target: string, label: string) {
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SkillRepositoryError('SKILL_PATH_INVALID', `${label} must be inside the workspace`);
  }
  return resolved;
}
