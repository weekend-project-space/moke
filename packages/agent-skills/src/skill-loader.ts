import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { LoadedSkill, SkillManifest } from './skill-types.js';

const DEFAULT_SKILL_DIR = '.moke/skills';
const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
  readonly root: string;
  readonly skillsDir: string;

  constructor(root: string, skillsDir = DEFAULT_SKILL_DIR) {
    this.root = path.resolve(root);
    this.skillsDir = path.resolve(this.root, skillsDir);
  }

  async list(): Promise<SkillManifest[]> {
    const entries = await safeReadDir(this.skillsDir);
    const manifests = await Promise.all(
      entries.map(async (entry) => {
        const skillPath = path.join(this.skillsDir, entry, SKILL_FILE);
        const info = await safeStat(skillPath);
        if (!info?.isFile()) return null;

        const content = await readFile(skillPath, 'utf8');
        const parsed = parseSkillFile(content);
        const name = parsed.frontmatter.name || entry;
        const description = parsed.frontmatter.description || firstParagraph(parsed.body);

        return {
          name,
          description,
          path: path.relative(this.root, skillPath),
        };
      }),
    );

    return manifests.filter((skill): skill is SkillManifest => Boolean(skill));
  }

  async read(name: string): Promise<LoadedSkill> {
    const skills = await this.list();
    const manifest = skills.find((skill) => skill.name === name);
    if (!manifest) {
      throw new Error(`Skill not found: ${name}`);
    }

    const content = await readFile(path.join(this.root, manifest.path), 'utf8');
    const parsed = parseSkillFile(content);

    return {
      ...manifest,
      content: parsed.body.trim(),
    };
  }
}

async function safeReadDir(dir: string) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function safeStat(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function parseSkillFile(content: string) {
  if (!content.startsWith('---')) {
    return { frontmatter: {} as Record<string, string>, body: content };
  }

  const end = content.indexOf('\n---', 3);
  if (end < 0) {
    return { frontmatter: {} as Record<string, string>, body: content };
  }

  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).trim();
  const frontmatter: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index < 0) continue;

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}

function firstParagraph(content: string) {
  return content
    .replace(/^# .+$/m, '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(Boolean) || '';
}
