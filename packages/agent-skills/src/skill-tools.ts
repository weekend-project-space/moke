import { z } from 'zod';

import {
  createRuntimeToolResult,
  type RuntimeContextItem,
  type RuntimeTool,
  type RuntimeToolResult,
} from '@moke/agent-runtime';
import type { SkillLoader } from './skill-loader.js';

const activateSkillSchema = z.object({
  id: z.string().min(1),
});

export function createActivateSkillTool(loader: SkillLoader): RuntimeTool<typeof activateSkillSchema, RuntimeToolResult> {
  return {
    name: 'activate_skill',
    description: 'Activate an available agent skill for the current session.',
    risk: 'safe',
    schema: activateSkillSchema,
    async handler(input, context) {
      const skill = await loader.read(input.id);
      const activation = context.contentManager?.addSkill(skill) || { status: 'unavailable' as const };
      const publicOutput = {
        id: skill.id,
        name: skill.name,
        status: activation.status,
        scope: 'session',
        ...(activation.truncated
          ? {
              truncated: true,
              notice: 'Skill instructions were truncated to fit the context budget.',
            }
          : {}),
      };

      if (activation.status !== 'activated') return createRuntimeToolResult({ publicOutput });

      const instructions = `<active_skill id="${escapeAttr(skill.id)}" name="${escapeAttr(skill.name)}"${activation.truncated ? ' truncated="true"' : ''}>\n${activation.content || skill.content}\n</active_skill>`;
      if (skill.authority === 'external') {
        return createRuntimeToolResult({
          publicOutput,
          modelOutput: { ...publicOutput, instructions },
        });
      }

      const skillContext: RuntimeContextItem = {
        authority: skill.authority,
        content: instructions,
        scope: 'session',
      };
      return createRuntimeToolResult({
        publicOutput,
        context: [skillContext],
      });
    },
  };
}

function escapeAttr(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
