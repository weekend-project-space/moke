import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DiscoveryService } from './discovery-service.js';

test('workspace discovery searches within the selected root and skips noisy directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moke-discovery-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.ts'), 'export {}');
  await writeFile(path.join(root, 'node_modules', 'pkg', 'hidden.ts'), '');
  const service = new DiscoveryService({ get: () => ({ providers: [] }) } as never);

  const entries = await service.listEntries(root, { query: 'app' });
  assert.deepEqual(entries, [{ name: 'app.ts', path: path.join(root, 'src', 'app.ts') }]);
  await assert.rejects(() => service.listEntries(root, { path: '..' }), /outside workspace/);
});

test('workspace contexts expire and model capabilities expose reasoning support', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moke-context-'));
  const service = new DiscoveryService({
    get: () => ({ providers: [
      { id: 'responses', name: 'OpenAI', model: 'gpt', type: 'openai-responses' },
      { id: 'chat', name: 'Local Qwen', model: 'qwen', type: 'openai-compatible', reasoningProvider: 'none' },
    ] }),
  } as never);
  const context = service.createContext(root, 1_000);
  assert.equal(service.resolveContext(context.id, undefined, root), root);
  assert.deepEqual(service.listModels(), [
    { provider: 'responses', provider_name: 'OpenAI', models: [{ name: 'gpt', supports_reasoning: true }] },
    { provider: 'chat', provider_name: 'Local Qwen', models: [{ name: 'qwen', supports_reasoning: false }] },
  ]);
});

test('session workspace is trusted for discovery without persistent root permission', () => {
  const service = new DiscoveryService({ get: () => ({ providers: [] }) } as never, () => []);

  assert.equal(
    service.resolveContext(undefined, 'E:\\work\\selected-project', 'E:\\work\\default-project'),
    'E:\\work\\selected-project',
  );
});

test('draft workspace context grants temporary discovery authority for a selected absolute root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moke-draft-context-'));
  await writeFile(path.join(root, 'draft.txt'), 'draft');
  const service = new DiscoveryService({ get: () => ({ providers: [] }) } as never, () => []);

  const context = service.createContext(root);
  const contextRoot = service.resolveContext(context.id, undefined, path.dirname(root));

  assert.equal(contextRoot, root);
  assert.deepEqual(await service.listEntries(contextRoot, { query: 'draft', includeDirectories: false }), [
    { name: 'draft.txt', path: path.join(root, 'draft.txt') },
  ]);
  assert.throws(() => service.createContext('relative-workspace'), /absolute path/);
});
