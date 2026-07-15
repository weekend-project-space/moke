import { z } from 'zod';

import type { RuntimeTool, SystemBackend } from '@moke/agent-runtime';

const globSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export function createGlobTool(system: SystemBackend): RuntimeTool<typeof globSchema> {
  return {
    name: 'glob',
    description: 'Find files matching a glob pattern in the workspace.',
    risk: 'safe',
    schema: globSchema,
    async handler(input) {
      return system.glob(input.pattern, {
        path: input.path,
        limit: input.limit,
      });
    },
  };
}
