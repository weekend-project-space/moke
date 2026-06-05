import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { RuntimeTool } from '../tool-registry.js';

function resolveWorkspacePath(workspace: string, requestedPath: string) {
  const fullPath = path.resolve(workspace, requestedPath);
  const root = path.resolve(workspace);
  if (!fullPath.startsWith(root)) {
    throw new Error('Path escapes workspace');
  }
  return fullPath;
}

const readFileSchema = z.object({
  path: z.string().min(1),
});

export function createReadFileTool(): RuntimeTool<typeof readFileSchema> {
  return {
    name: 'read_file',
    description: 'Read a text file from the workspace.',
    risk: 'safe',
    schema: readFileSchema,
    async handler(input, context) {
      const fullPath = resolveWorkspacePath(context.workspace, input.path);
      const info = await stat(fullPath);
      if (info.size > 128_000) {
        throw new Error('File is too large to read in this runtime');
      }

      const content = await readFile(fullPath, 'utf8');
      if (content.includes('\u0000')) {
        throw new Error('File appears to be binary');
      }

      return {
        path: input.path,
        content: content.slice(0, 8000),
        truncated: content.length > 8000,
      };
    },
  };
}
