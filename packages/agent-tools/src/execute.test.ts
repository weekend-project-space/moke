import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecuteTool } from './execute.js';
import type { ExecutableSystemBackend } from '@moke/agent-runtime';

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

test('execute delegates all approval decisions to ToolRegistry', async () => {
  const { calls, system } = createSystemBackend();
  const tool = createExecuteTool(system);

  const result = await tool.handler(
    { command: 'echo hello && echo world' },
    { workspace: 'E:\\work\\test\\moke' },
  );

  assert.deepEqual(result, { exit_code: 0, stdout: 'ok', stderr: '' });
  assert.deepEqual(calls, ['echo hello && echo world']);
});
