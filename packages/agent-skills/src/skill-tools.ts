import { z } from 'zod';

import type { RuntimeTool } from '@moke/agent-runtime';
import type { SkillLoader } from './skill-loader.js';

const listSkillsSchema = z.object({});
const readSkillSchema = z.object({
  name: z.string().min(1),
});

export function createListSkillsTool(loader: SkillLoader): RuntimeTool<typeof listSkillsSchema> {
  return {
    name: 'list_skills',
    description: 'List available agent skills with descriptions.',
    risk: 'safe',
    schema: listSkillsSchema,
    async handler() {
      return {
        skills: await loader.list(),
      };
    },
  };
}

export function createReadSkillTool(loader: SkillLoader): RuntimeTool<typeof readSkillSchema> {
  return {
    name: 'active_skill',
    description: 'Read and activate an agent skill by name.',
    risk: 'safe',
    schema: readSkillSchema,
    async handler(input, context) {
      const skill = await loader.read(input.name);
      context.contentManager?.addSkill(skill);

      return {
        name: skill.name,
        description: skill.description,
        activated: Boolean(context.contentManager),
      };
    },
  };
}
