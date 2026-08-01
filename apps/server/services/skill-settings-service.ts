import { SkillRepository, type SkillDraft } from '@moke/agent-skills';

export class SkillSettingsService {
  private readonly repository: SkillRepository;

  constructor(workspace: string) {
    this.repository = new SkillRepository(workspace);
  }

  async list() {
    return {
      root: this.repository.skillsDir,
      skills: await this.repository.listAll(),
    };
  }

  get(id: string) {
    return this.repository.get(id);
  }

  create(input: Record<string, unknown>) {
    return this.repository.create(readDraft(input));
  }

  update(id: string, input: Record<string, unknown>) {
    const draft = readDraft({ ...input, id });
    return this.repository.update(id, draft);
  }

  async setEnabled(id: string, input: Record<string, unknown>) {
    await this.repository.setEnabled(id, input.enabled !== false);
    return this.repository.get(id);
  }

  async remove(id: string) {
    await this.repository.remove(id);
    return { deleted: true, id };
  }

  validate(input: Record<string, unknown>) {
    const draft = readDraft(input);
    const currentId = typeof input.currentId === 'string' ? input.currentId : undefined;
    return this.repository.validate(draft, currentId);
  }
}

function readDraft(input: Record<string, unknown>): SkillDraft {
  return {
    id: stringValue(input.id),
    name: stringValue(input.name),
    description: stringValue(input.description),
    content: stringValue(input.content),
    enabled: input.enabled !== false,
  };
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}
