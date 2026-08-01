import type { RuntimeContextItem, RuntimeSkillActivationResult } from '@moke/agent-runtime';

export type SkillAuthority = 'trusted' | 'user' | 'external';

export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  authority: SkillAuthority;
};

export type LoadedSkill = SkillManifest & {
  content: string;
};

export type SkillActivationStatus = 'activated' | 'already_active' | 'limit_reached' | 'content_too_large' | 'unavailable';
export type SkillActivationResult = RuntimeSkillActivationResult;

export type SkillContentManager = {
  addSkill(skill: LoadedSkill): SkillActivationResult;
  buildInitialContext(): RuntimeContextItem[];
};

export type ManagedSkill = SkillManifest & {
  valid: boolean;
  error?: string;
  updatedAt: string;
};

export type SkillDraft = {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
};
