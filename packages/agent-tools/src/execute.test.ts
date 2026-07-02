import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecuteTool } from './execute.js';
import type { ExecutableSystemBackend } from '../../agent-runtime/src/index.js';

function createSystemBackend() {
  const calls: string[] = [];
  const system: ExecutableSystemBackend = {
    rootDir: 'E:\\work\\test\\moke',
    async ls() {
      return { path: '.', entries: [] };
    },
    async readFile() {
      return { path: 'a.md', content: '', lines: [], offset: 0 };
    },
    async grep() {
      return { mode: 'content', matches: [] };
    },
    async glob() {
      return { matches: [] };
    },
    async writeFile() {
      return { path: 'a.md', bytes: 0 };
    },
    async editFile() {
      return { path: 'a.md', replacements: 0 };
    },
    async execute(command) {
      calls.push(command);
      return { exit_code: 0, stdout: 'ok', stderr: '' };
    },
  };

  return { calls, system };
}

test('execute asks for approval before complex shell commands', async () => {
  const { calls, system } = createSystemBackend();
  const tool = createExecuteTool(system);
  let approvalReason = '';

  const result = await tool.handler(
    { command: 'echo hello && echo world' },
    {
      workspace: 'E:\\work\\test\\moke',
      approveTool: async (input) => {
        approvalReason = input.reason;
        return { approved: true, scope: 'once' };
      },
    },
  );

  assert.deepEqual(result, { exit_code: 0, stdout: 'ok', stderr: '' });
  assert.match(approvalReason, /shell \u63a7\u5236\u7b26/);
  assert.deepEqual(calls, ['echo hello && echo world']);
});

test('execute skips approval for allowlisted npm command chains', async () => {
  const { calls, system } = createSystemBackend();
  const tool = createExecuteTool(system);

  const result = await tool.handler(
    { command: 'npm test && npm run build' },
    {
      workspace: 'E:\\work\\test\\moke',
      approveTool: async () => {
        throw new Error('approval should not be requested');
      },
    },
  );

  assert.deepEqual(result, { exit_code: 0, stdout: 'ok', stderr: '' });
  assert.deepEqual(calls, ['npm test && npm run build']);
});

test('execute does not run complex commands when approval is rejected', async () => {
  const { calls, system } = createSystemBackend();
  const tool = createExecuteTool(system);

  await assert.rejects(
    () =>
      tool.handler(
        { command: 'powershell -EncodedCommand AAAA' },
        {
          workspace: 'E:\\work\\test\\moke',
          approveTool: async () => ({ approved: false, message: 'no' }),
        },
      ),
    /no/,
  );

  assert.deepEqual(calls, []);
});

test('execute does not ask approval for non-shell args', async () => {
  const { calls, system } = createSystemBackend();
  const tool = createExecuteTool(system);

  await tool.handler(
    { command: 'node', args: ['-e', "process.stdout.write('ok');"] },
    {
      workspace: 'E:\\work\\test\\moke',
      approveTool: async () => {
        throw new Error('approval should not be requested');
      },
    },
  );

  assert.deepEqual(calls, ['node']);
});

test('execute asks approval for shell args with encoded content', async () => {
  const { calls, system } = createSystemBackend();
  const tool = createExecuteTool(system);

  await tool.handler(
    { command: 'powershell', args: ['-EncodedCommand', 'AAAA'] },
    {
      workspace: 'E:\\work\\test\\moke',
      approveTool: async () => ({ approved: true, scope: 'once' }),
    },
  );

  assert.deepEqual(calls, ['powershell']);
});
