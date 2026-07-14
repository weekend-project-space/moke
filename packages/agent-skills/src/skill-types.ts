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

export type SkillContentManager = {
  addSkill(skill: LoadedSkill): void;
  buildContext(): string;
  reset(): void;
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
