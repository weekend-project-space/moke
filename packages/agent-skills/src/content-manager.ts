import type { LoadedSkill, SkillContentManager } from './skill-types.js';

const DEFAULT_MAX_SKILLS = 2;
const DEFAULT_MAX_CHARS_PER_SKILL = 4000;

type ContentManagerOptions = {
  maxSkills?: number;
  maxCharsPerSkill?: number;
};

export class ContentManager implements SkillContentManager {
  private readonly active = new Map<string, LoadedSkill>();
  private readonly maxSkills: number;
  private readonly maxCharsPerSkill: number;

  constructor(options: ContentManagerOptions = {}) {
    this.maxSkills = options.maxSkills ?? DEFAULT_MAX_SKILLS;
    this.maxCharsPerSkill = options.maxCharsPerSkill ?? DEFAULT_MAX_CHARS_PER_SKILL;
  }

  addSkill(skill: LoadedSkill) {
    if (this.active.has(skill.name)) return;
    if (this.active.size >= this.maxSkills) return;

    this.active.set(skill.name, skill);
  }

  buildContext() {
    if (this.active.size === 0) return '';

    const skills = [...this.active.values()]
      .map((skill) => {
        const content = skill.content.slice(0, this.maxCharsPerSkill);
        return `<skill name="${escapeAttr(skill.name)}">\n${content}\n</skill>`;
      })
      .join('\n\n');

    return `<active_skills>\n${skills}\n</active_skills>`;
  }

  reset() {
    this.active.clear();
  }
}

function escapeAttr(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
