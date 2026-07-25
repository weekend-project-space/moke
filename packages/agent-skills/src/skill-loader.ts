import path from 'node:path';

import type { LoadedSkill, SkillAuthority, SkillManifest } from './skill-types.js';
import { SkillRepository } from './skill-repository.js';

const DEFAULT_SKILL_DIR = '.moke/skills';

export class SkillLoader {
  readonly root: string;
  readonly skillsDir: string;
  private readonly repository: SkillRepository;

  constructor(root: string, skillsDir = DEFAULT_SKILL_DIR, authority: SkillAuthority = 'user') {
    this.root = path.resolve(root);
    this.skillsDir = path.resolve(this.root, skillsDir);
    this.repository = new SkillRepository(this.root, skillsDir, undefined, authority);
  }

  async list(): Promise<SkillManifest[]> {
    return this.repository.listEnabled();
  }

  async read(name: string): Promise<LoadedSkill> {
    return this.repository.readEnabled(name);
  }
}
