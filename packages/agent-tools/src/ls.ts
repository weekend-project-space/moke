import { z } from 'zod';

import type { RuntimeTool, SystemBackend } from '@moke/agent-runtime';

const lsSchema = z.object({
  path: z.string().optional(),
});

export function createLsTool(system: SystemBackend): RuntimeTool<typeof lsSchema> {
  return {
    name: 'ls',
    description: 'List files in a workspace directory with metadata.',
    approval: 'none',
    schema: lsSchema,
    async handler(input, context) {
      return system.ls(input.path, {
        workspaceRoot: context.workspace,
        approvedRoots: context.workspaceRoots?.(),
      });
    },
  };
}
