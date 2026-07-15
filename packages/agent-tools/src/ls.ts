import { z } from 'zod';

import type { RuntimeTool, SystemBackend } from '@moke/agent-runtime';

const lsSchema = z.object({
  path: z.string().optional(),
});

export function createLsTool(system: SystemBackend): RuntimeTool<typeof lsSchema> {
  return {
    name: 'ls',
    description: 'List files in a workspace directory with metadata.',
    risk: 'safe',
    schema: lsSchema,
    async handler(input) {
      return system.ls(input.path);
    },
  };
}
