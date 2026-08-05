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
    approval: 'none',
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

test('ToolRegistry grants an approved path only to its retry', async () => {
  let attempts = 0;
  const rootsSeen: string[][] = [];
  const registry = new ToolRegistry().register({
    name: 'needs_path',
    description: 'Needs path approval',
    approval: 'none',
    schema: z.object({}),
    async handler(_input, context) {
      attempts += 1;
      rootsSeen.push(context.workspaceRoots?.() || []);
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

  await registry.execute('needs_path', {}, {
    workspace: 'E:\\work\\test\\moke',
    workspaceRoots: () => ['E:\\session-root'],
    approveWorkspacePath: async () => ({
      approved: true,
      scope: 'once',
      approvedRoots: ['E:\\notes'],
    }),
  });

  assert.deepEqual(rootsSeen, [
    ['E:\\session-root'],
    ['E:\\session-root', 'E:\\notes'],
  ]);
});

test('ToolRegistry approves required tools before executing their handler', async () => {
  const events: string[] = [];
  const registry = new ToolRegistry().register({
    name: 'writes_state',
    description: 'Writes state',
    approval: 'required',
    schema: z.object({ value: z.string() }),
    async handler() {
      events.push('handler');
      return { ok: true };
    },
  });

  const result = await registry.execute('writes_state', { value: 'approved' }, {
    workspace: 'E:\\work\\test\\moke',
    approveTool: async (input) => {
      events.push('approval');
      assert.equal(input.tool, 'writes_state');
      assert.deepEqual(input.input, { value: 'approved' });
      return { approved: true, scope: 'once' };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, ['approval', 'handler']);
});

test('ToolRegistry does not execute a required tool when approval is rejected', async () => {
  let executed = false;
  const registry = new ToolRegistry().register({
    name: 'writes_state',
    description: 'Writes state',
    approval: 'required',
    schema: z.object({}),
    async handler() {
      executed = true;
      return { ok: true };
    },
  });

  await assert.rejects(
    () => registry.execute('writes_state', {}, {
      workspace: 'E:\\work\\test\\moke',
      approveTool: async () => ({ approved: false, message: 'Denied by reviewer' }),
    }),
    (error: unknown) => {
      assert.equal((error as { output?: { error?: { code?: string } } }).output?.error?.code, 'TOOL_APPROVAL_REJECTED');
      return true;
    },
  );
  assert.equal(executed, false);
});

test('ToolRegistry fails closed when a required tool has no approval service', async () => {
  let executed = false;
  const registry = new ToolRegistry().register({
    name: 'writes_state',
    description: 'Writes state',
    approval: 'required',
    schema: z.object({}),
    async handler() {
      executed = true;
      return { ok: true };
    },
  });

  await assert.rejects(
    () => registry.execute('writes_state', {}, { workspace: 'E:\\work\\test\\moke' }),
    (error: unknown) => {
      assert.equal((error as { output?: { error?: { code?: string } } }).output?.error?.code, 'TOOL_APPROVAL_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(executed, false);
});

test('ToolRegistry defaults an undeclared approval policy to required', async () => {
  let executed = false;
  const registry = new ToolRegistry().register({
    name: 'new_tool',
    description: 'A newly registered tool without an explicit approval policy',
    schema: z.object({}),
    async handler() {
      executed = true;
      return { ok: true };
    },
  });

  await assert.rejects(
    () => registry.execute('new_tool', {}, { workspace: 'E:\\work\\test\\moke' }),
    (error: unknown) => {
      assert.equal((error as { output?: { error?: { code?: string } } }).output?.error?.code, 'TOOL_APPROVAL_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(executed, false);
});

test('ToolRegistry creates a scoped snapshot without mutating the base registry', () => {
  const base = new ToolRegistry().register({
    name: 'base_tool',
    description: 'Base tool',
    approval: 'none',
    schema: z.object({}),
    async handler() { return { ok: true }; },
  });
  const scoped = base.withTools([{
    name: 'workspace_tool',
    description: 'Workspace tool',
    approval: 'none',
    schema: z.object({}),
    async handler() { return { ok: true }; },
  }]);

  assert.deepEqual(base.list().map((tool) => tool.name), ['base_tool']);
  assert.deepEqual(scoped.list().map((tool) => tool.name), ['base_tool', 'workspace_tool']);
});
