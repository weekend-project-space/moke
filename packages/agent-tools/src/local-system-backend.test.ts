import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { LocalSystemBackend } from './local-system-backend.js';

function createBackend(options: { executeDelayMs?: number } = {}) {
  const calls: string[] = [];
  const backend = {
    id: 'fake-backend',
    calls,
    async ls() {
      return {};
    },
    async read() {
      return {};
    },
    async readRaw() {
      return {};
    },
    async grep() {
      return {};
    },
    async glob() {
      return {};
    },
    async write() {
      return {};
    },
    async edit() {
      return {};
    },
    async execute(command: string) {
      calls.push(command);
      if (options.executeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.executeDelayMs));
      }
      return { exitCode: 0, output: 'ok', truncated: false };
    },
  };

  return backend;
}

test('execute defaults cwd to the workspace root', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await system.execute('npm test');

  assert.match(backend.calls[0], /^cd /);
  assert.match(backend.calls[0], /npm test$/);
});

test('execute rejects absolute command paths outside workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('copy E:\\work\\test\\moke\\a.md E:\\a.md'),
    /Command path escapes workspace: E:\\a\.md/,
  );
});

test('execute allows absolute command paths inside workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await system.execute('type E:\\work\\test\\moke\\a.md');

  assert.equal(backend.calls.length, 1);
});

test('execute rejects UNC paths', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('copy a.md \\\\server\\share\\a.md'),
    /Command path escapes workspace: \\\\server\\share\\a\.md/,
  );
});

test('execute rejects Windows drive-relative paths', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('copy a.md E:a.md'),
    /Command path is ambiguous outside workspace: E:a\.md/,
  );
});

test('execute respects timeoutMs', async () => {
  const backend = createBackend({ executeDelayMs: 20 });
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('npm test', [], { timeoutMs: 1 }),
    /Command timed out after 1ms: npm test/,
  );
});
