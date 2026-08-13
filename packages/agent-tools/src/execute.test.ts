import assert from 'node:assert/strict';
import test from 'node:test';

import { createExecuteTool } from './execute.js';
import type { ExecutableSystemBackend } from '@moke/agent-runtime';

function createSystemBackend() {
  const calls: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const system: ExecutableSystemBackend = {
    rootDir: 'E:\\work\\test\\moke',
    async ls() {
      return { path: '.', entries: [] };
    },
    async readFile() {
      return { path: 'a.md', content: '', lines: [], offset: 0 };
    },
    async readImage() {
      return { path: 'a.png', mime_type: 'image/png', size: 1, data_url: 'data:image/png;base64,AA==' };
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
    async execute(command, _args, options) {
      calls.push(command);
      timeouts.push(options?.timeoutMs);
      return { exit_code: 0, stdout: 'ok', stderr: '' };
    },
  };

  return { calls, timeouts, system };
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

test('execute raises explicit timeouts below the shell startup floor', async () => {
  const { timeouts, system } = createSystemBackend();
  const tool = createExecuteTool(system);

  await tool.handler(
    { command: 'pwd', timeout_ms: 10 },
    { workspace: 'E:\\work\\test\\moke' },
  );

  assert.deepEqual(timeouts, [5_000]);
});
