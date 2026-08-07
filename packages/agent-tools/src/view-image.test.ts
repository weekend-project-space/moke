import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeToolResult, SystemAccessOptions, SystemBackend } from '@moke/agent-runtime';
import { createViewImageTool } from './view-image.js';

test('view_image keeps image data out of its public result', async () => {
  let access: SystemAccessOptions | undefined;
  const system = {
    async readImage(_path: string, nextAccess?: SystemAccessOptions) {
      access = nextAccess;
      return {
        path: 'images/example.png',
        mime_type: 'image/png',
        size: 1,
        data_url: 'data:image/png;base64,AA==',
      };
    },
  } as SystemBackend;
  const tool = createViewImageTool(system);

  const result = await tool.handler({ path: 'images/example.png' }, { workspace: 'E:\\work\\project' }) as RuntimeToolResult;

  assert.deepEqual(result.publicOutput, {
    path: 'images/example.png',
    mime_type: 'image/png',
    size: 1,
  });
  assert.deepEqual(result.images, [{ data_url: 'data:image/png;base64,AA==' }]);
  assert.deepEqual(access, { workspaceRoot: 'E:\\work\\project', approvedRoots: undefined });
  assert.doesNotMatch(JSON.stringify(result.publicOutput), /base64/);
});
