import { z } from 'zod';

import type { RuntimeTool } from '@moke/agent-runtime';
import type { SkillLoader } from './skill-loader.js';

const activateSkillSchema = z.object({
  id: z.string().min(1),
});

export function createActivateSkillTool(loader: SkillLoader): RuntimeTool<typeof activateSkillSchema> {
  return {
    name: 'activate_skill',
    description: 'Activate an available agent skill for the current run.',
    risk: 'safe',
    schema: activateSkillSchema,
    async handler(input, context) {
      const skill = await loader.read(input.id);
      const status = context.contentManager?.addSkill(skill) || 'unavailable';

      return {
        id: skill.id,
        name: skill.name,
        status,
      };
    },
  };
}
