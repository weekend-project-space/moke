import { z } from 'zod';

import { createRuntimeToolResult, type RuntimeTool, type SystemBackend } from '@moke/agent-runtime';

const viewImageSchema = z.object({
  path: z.string().min(1),
});

export function createViewImageTool(system: SystemBackend): RuntimeTool<typeof viewImageSchema> {
  return {
    name: 'view_image',
    description: 'View a PNG, JPEG, WebP, or GIF image from the workspace.',
    approval: 'none',
    schema: viewImageSchema,
    async handler(input, context) {
      const image = await system.readImage(input.path, {
        workspaceRoot: context.workspace,
        approvedRoots: context.workspaceRoots?.(),
      });
      const output = {
        path: image.path,
        mime_type: image.mime_type,
        size: image.size,
      };
      return createRuntimeToolResult({
        publicOutput: output,
        images: [{ data_url: image.data_url }],
      });
    },
  };
}
