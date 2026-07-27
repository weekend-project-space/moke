import { z } from 'zod';

import type { RuntimeTool, SystemBackend } from '@moke/agent-runtime';

const readFileSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export function createReadFileTool(system: SystemBackend): RuntimeTool<typeof readFileSchema> {
  return {
    name: 'read_file',
    description: 'Read a text file from the workspace.',
    approval: 'none',
    schema: readFileSchema,
    async handler(input, context) {
      const result = await system.readFile(input.path, {
        offset: input.offset,
        limit: input.limit,
      }, { approvedRoots: context.workspaceRoots?.() });
      return {
        path: result.path,
        content: result.content,
        lines: result.lines,
        offset: result.offset,
        limit: result.limit,
        start_line: result.start_line,
        end_line: result.end_line,
        total_lines: result.total_lines,
        truncated: result.truncated,
        content_blocks: result.content_blocks,
      };
    },
  };
}
