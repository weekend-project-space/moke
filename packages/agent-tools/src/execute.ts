import { z } from 'zod';

import type { ExecutableSystemBackend, RuntimeTool } from '@moke/agent-runtime';

const executeSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().max(120000).optional(),
});

export function createExecuteTool(system: ExecutableSystemBackend): RuntimeTool<typeof executeSchema> {
  return {
    name: 'execute',
    description: 'Run a shell command in the workspace environment.',
    approval: 'required',
    schema: executeSchema,
    async handler(input, context) {
      return system.execute(input.command, input.args, {
        cwd: input.cwd,
        timeoutMs: input.timeout_ms,
      }, { approvedRoots: context.workspaceRoots?.() });
    },
  };
}
