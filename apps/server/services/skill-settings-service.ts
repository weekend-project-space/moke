import { SkillRepository } from '@moke/agent-skills';

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

  importFromPath(input: Record<string, unknown>) {
    const sourcePath = typeof input.path === 'string' ? input.path : '';
    return this.repository.importFromPath(sourcePath);
  }

  async setEnabled(id: string, input: Record<string, unknown>) {
    await this.repository.setEnabled(id, input.enabled !== false);
    return this.repository.get(id);
  }

  async remove(id: string) {
    await this.repository.remove(id);
    return { deleted: true, id };
  }

}
