import type { RuntimeContextItem } from '@moke/agent-runtime';
import type { LoadedSkill, SkillActivationResult, SkillContentManager, SkillManifest } from './skill-types.js';

type ActiveSkill = Pick<LoadedSkill, 'id' | 'name' | 'description' | 'path' | 'content' | 'authority'>;

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
    this.catalog = [...(options.catalog || [])].sort((left, right) => {
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    });
    this.maxSkills = normalizeLimit(options.maxSkills, DEFAULT_MAX_SKILLS);
    this.maxTokensPerSkill = normalizeLimit(options.maxTokensPerSkill, DEFAULT_MAX_TOKENS_PER_SKILL);
    this.maxCatalogTokens = normalizeLimit(options.maxCatalogTokens, DEFAULT_MAX_CATALOG_TOKENS);
    this.maxActiveTokens = normalizeLimit(options.maxActiveTokens, this.maxSkills * this.maxTokensPerSkill);
  }

  addSkill(skill: ActiveSkill): SkillActivationResult {
    if (this.active.has(skill.id)) return { status: 'already_active' };
    if (this.active.size >= this.maxSkills) return { status: 'limit_reached' };
    const skillTokens = estimateTokens(skill.content);
    const activeTokens = [...this.active.values()].reduce((total, activeSkill) => total + estimateTokens(activeSkill.content), 0);
    const availableTokens = Math.min(this.maxTokensPerSkill, this.maxActiveTokens - activeTokens);
    if (availableTokens <= 0) return { status: 'content_too_large' };

    const prepared = skillTokens > availableTokens
      ? truncateSkillContent(skill.content, availableTokens)
      : { content: skill.content, truncated: false };
    if (!prepared.content) return { status: 'content_too_large' };

    this.active.set(skill.id, { ...skill, content: prepared.content });
    return {
      status: 'activated',
      content: prepared.content,
      ...(prepared.truncated ? { truncated: true } : {}),
    };
  }

  buildInitialContext(): RuntimeContextItem[] {
    const visibleSkills = this.catalog.filter((skill) => skill.authority !== 'external');
    const entries = new Map<'trusted' | 'user', string[]>([
      ['trusted', []],
      ['user', []],
    ]);
    let catalogTokens = 0;
    let included = 0;

    for (const skill of visibleSkills) {
      if (skill.authority === 'external') continue;
      const entry = `<skill id="${escapeAttr(skill.id)}" name="${escapeAttr(skill.name)}" description="${escapeAttr(skill.description)}" />`;
      const nextTokens = catalogTokens + estimateTokens(entry);
      if (nextTokens > this.maxCatalogTokens) break;
      entries.get(skill.authority)?.push(entry);
      catalogTokens = nextTokens;
      included++;
    }

    const omitted = visibleSkills.length - included;
    const noteAuthority = (entries.get('user')?.length || 0) > 0 ? 'user' : 'trusted';
    return (['trusted', 'user'] as const).flatMap((authority) => {
      const authorityEntries = entries.get(authority) || [];
      if (authorityEntries.length === 0) return [];
      const note = omitted > 0 && authority === noteAuthority
        ? `\n<!-- ${omitted} additional skills omitted from the catalog -->`
        : '';
      return [{
        authority,
        content: `<available_skills>\n${authorityEntries.join('\n')}${note}\n</available_skills>`,
      }];
    });
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

const TRUNCATION_NOTICE = '[Skill content truncated to fit the context budget.]';

function truncateSkillContent(value: string, maxTokens: number) {
  const suffix = `\n\n${TRUNCATION_NOTICE}`;
  const contentBudget = maxTokens - estimateTokens(suffix);
  if (contentBudget <= 0) return { content: '', truncated: true };

  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join('')) <= contentBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const content = characters.slice(0, low).join('').trimEnd();
  return { content: `${content}${suffix}`, truncated: true };
}

function normalizeLimit(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}
