import { z } from 'zod';

import type { RuntimeTool, WritableSystemBackend } from '@moke/agent-runtime';

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export function createWriteFileTool(system: WritableSystemBackend): RuntimeTool<typeof writeFileSchema> {
  return {
    name: 'write_file',
    description: 'Create or overwrite a workspace file.',
    approval: 'required',
    schema: writeFileSchema,
    async handler(input, context) {
      return system.writeFile(input.path, input.content, { approvedRoots: context.workspaceRoots?.() });
    },
  };
}
