import { z } from 'zod';

import type { RuntimeTool, WritableSystemBackend } from '@moke/agent-runtime';

const editFileSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

export function createEditFileTool(system: WritableSystemBackend): RuntimeTool<typeof editFileSchema> {
  return {
    name: 'edit_file',
    description: 'Perform exact string replacements in a workspace file.',
    approval: 'required',
    schema: editFileSchema,
    async handler(input, context) {
      return system.editFile(input.path, input.old_string, input.new_string, {
        replaceAll: input.replace_all,
      }, { workspaceRoot: context.workspace, approvedRoots: context.workspaceRoots?.() });
    },
  };
}
