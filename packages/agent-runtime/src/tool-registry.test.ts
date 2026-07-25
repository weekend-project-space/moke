import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { ToolRegistry } from './tool-registry.js';
import { PathRequiresApprovalError } from './workspace-approval.js';

test('ToolRegistry runs approval cleanup after an approved retry', async () => {
  let attempts = 0;
  let cleaned = false;
  const registry = new ToolRegistry().register({
    name: 'needs_path',
    description: 'Needs path approval',
    schema: z.object({}),
    async handler() {
      attempts += 1;
      if (attempts === 1) {
        throw new PathRequiresApprovalError({
          path: 'E:\\notes\\a.md',
          suggestedRoot: 'E:\\notes',
          reason: 'Command path requires approval: E:\\notes\\a.md',
        });
      }

      return { ok: true };
    },
  });

  const result = await registry.execute('needs_path', {}, {
    workspace: 'E:\\work\\test\\moke',
    approveWorkspacePath: async () => ({
      approved: true,
      scope: 'once',
      cleanup: () => {
        cleaned = true;
      },
    }),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.equal(cleaned, true);
});
