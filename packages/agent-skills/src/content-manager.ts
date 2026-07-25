import type { LoadedSkill, SkillActivationStatus, SkillContentManager, SkillManifest } from './skill-types.js';

type ActiveSkill = Pick<LoadedSkill, 'id' | 'name' | 'description' | 'path' | 'content'>;

const DEFAULT_MAX_SKILLS = 2;
const DEFAULT_MAX_TOKENS_PER_SKILL = 1200;
const DEFAULT_MAX_CATALOG_TOKENS = 3000;

type ContentManagerOptions = {
  catalog?: SkillManifest[];
  maxSkills?: number;
  maxTokensPerSkill?: number;
  maxCatalogTokens?: number;
  maxActiveTokens?: number;
};

export class ContentManager implements SkillContentManager {
  private readonly active = new Map<string, ActiveSkill>();
  private readonly catalog: SkillManifest[];
  private readonly maxSkills: number;
  private readonly maxTokensPerSkill: number;
  private readonly maxCatalogTokens: number;
  private readonly maxActiveTokens: number;

  constructor(options: ContentManagerOptions = {}) {
    this.catalog = [...(options.catalog || [])];
    this.maxSkills = normalizeLimit(options.maxSkills, DEFAULT_MAX_SKILLS);
    this.maxTokensPerSkill = normalizeLimit(options.maxTokensPerSkill, DEFAULT_MAX_TOKENS_PER_SKILL);
    this.maxCatalogTokens = normalizeLimit(options.maxCatalogTokens, DEFAULT_MAX_CATALOG_TOKENS);
    this.maxActiveTokens = normalizeLimit(options.maxActiveTokens, this.maxSkills * this.maxTokensPerSkill);
  }

  addSkill(skill: ActiveSkill): SkillActivationStatus {
    if (this.active.has(skill.id)) return 'already_active';
    if (this.active.size >= this.maxSkills) return 'limit_reached';
    const skillTokens = estimateTokens(skill.content);
    if (skillTokens > this.maxTokensPerSkill) return 'content_too_large';
    const activeTokens = [...this.active.values()].reduce((total, activeSkill) => total + estimateTokens(activeSkill.content), 0);
    if (activeTokens + skillTokens > this.maxActiveTokens) return 'content_too_large';

    this.active.set(skill.id, skill);
    return 'activated';
  }

  buildContext() {
    const blocks: string[] = [];
    if (this.catalog.length > 0) {
      const entries: string[] = [];
      let catalogTokens = 0;
      for (const skill of this.catalog) {
        const entry = `<skill id="${escapeAttr(skill.id)}" name="${escapeAttr(skill.name)}" description="${escapeAttr(skill.description)}" />`;
        const nextTokens = catalogTokens + estimateTokens(entry);
        if (nextTokens > this.maxCatalogTokens) break;
        entries.push(entry);
        catalogTokens = nextTokens;
      }
      const omitted = this.catalog.length - entries.length;
      const note = omitted > 0 ? `\n<!-- ${omitted} additional skills omitted from the catalog -->` : '';
      blocks.push(`<available_skills>\n${entries.join('\n')}${note}\n</available_skills>`);
    }

    if (this.active.size === 0) return blocks.join('\n\n');

    const skills = [...this.active.values()]
      .map((skill) => {
        return `<skill id="${escapeAttr(skill.id)}" name="${escapeAttr(skill.name)}">\n${skill.content}\n</skill>`;
      })
      .join('\n\n');

    blocks.push(`<active_skills>\n${skills}\n</active_skills>`);
    return blocks.join('\n\n');
  }
}

function escapeAttr(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function estimateTokens(value: string) {
  let tokens = 0;
  for (const character of value) {
    tokens += /[\u2e00-\u9fff]/u.test(character) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

function normalizeLimit(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}
