import { z } from 'zod';

import type { RuntimeTool, SystemBackend } from '@moke/agent-runtime';

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  mode: z.enum(['files', 'content', 'count']).optional(),
  context_lines: z.number().int().min(0).max(5).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export function createGrepTool(system: SystemBackend): RuntimeTool<typeof grepSchema> {
  return {
    name: 'grep',
    description: 'Search workspace file contents by pattern.',
    approval: 'none',
    schema: grepSchema,
    async handler(input, context) {
      return system.grep(input.pattern, {
        path: input.path,
        glob: input.glob,
        mode: input.mode,
        contextLines: input.context_lines,
        limit: input.limit,
      }, { approvedRoots: context.workspaceRoots?.() });
    },
  };
}
