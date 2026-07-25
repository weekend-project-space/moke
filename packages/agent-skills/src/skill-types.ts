export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
};

export type LoadedSkill = SkillManifest & {
  content: string;
};

export type SkillActivationStatus = 'activated' | 'already_active' | 'limit_reached' | 'content_too_large' | 'unavailable';

export type SkillContentManager = {
  addSkill(skill: LoadedSkill): SkillActivationStatus;
  buildContext(): string;
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
