import { z } from 'zod';

import type { RuntimeTool, WritableSystemBackend } from '../../agent-runtime/src/index.js';

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export function createWriteFileTool(system: WritableSystemBackend): RuntimeTool<typeof writeFileSchema> {
  return {
    name: 'write_file',
    description: 'Create or overwrite a workspace file.',
    risk: 'write',
    schema: writeFileSchema,
    async handler(input) {
      return system.writeFile(input.path, input.content);
    },
  };
}
