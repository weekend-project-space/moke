export type SkillManifest = {
  name: string;
  description: string;
  path: string;
};

export type LoadedSkill = SkillManifest & {
  content: string;
};

export type SkillContentManager = {
  addSkill(skill: LoadedSkill): void;
  buildContext(): string;
  reset(): void;
};
