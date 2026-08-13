import assert from 'node:assert/strict';
import test from 'node:test';

import type { BrowserBackend } from './browser-backend.js';
import { createTakeScreenshotTool, createTakeSnapshotTool } from './page-tools.js';

test('take_snapshot scopes file output to the active workspace', async () => {
  let workspaceRoot = '';
  const browser = {
    async takeSnapshot(_input, workspace) {
      workspaceRoot = workspace;
      return { pages: [], activePageId: null };
    },
  } as BrowserBackend;
  const tool = createTakeSnapshotTool(browser);

  await tool.handler({ filePath: 'artifacts/page.json' }, { workspace: 'E:\\work\\project' });

  assert.equal(workspaceRoot, 'E:\\work\\project');
});

test('take_snapshot defaults to act and preserves actionable elements', async () => {
  const browser = {
    async takeSnapshot() {
      return {
        pages: [],
        activePageId: null,
        snapshot: snapshotWithElements(),
      };
    },
  } as BrowserBackend;
  const tool = createTakeSnapshotTool(browser);

  const result = await tool.handler({}, { workspace: 'E:\\work\\project' });

  assert.deepEqual(result.snapshot?.elements, [{ uid: 'button-1', role: 'button', name: 'Continue', tag: 'button' }]);
});

test('take_snapshot omits elements when interaction is observe', async () => {
  let backendInput: unknown;
  const browser = {
    async takeSnapshot(input) {
      backendInput = input;
      return {
        pages: [],
        activePageId: null,
        snapshot: snapshotWithElements(),
      };
    },
  } as BrowserBackend;
  const tool = createTakeSnapshotTool(browser);

  const result = await tool.handler({ interaction: 'observe' }, { workspace: 'E:\\work\\project' });

  assert.deepEqual(backendInput, {});
  assert.equal('elements' in (result.snapshot ?? {}), false);
  assert.equal(result.snapshot?.content.markdown, '# Example');
});

test('take_screenshot scopes output to the active workspace', async () => {
  let workspaceRoot = '';
  const browser = {
    async takeScreenshot(_input, workspace) {
      workspaceRoot = workspace;
      return { pages: [], activePageId: null };
    },
  } as BrowserBackend;
  const tool = createTakeScreenshotTool(browser);

  await tool.handler({ path: 'artifacts/page.png' }, { workspace: 'E:\\work\\project' });

  assert.equal(workspaceRoot, 'E:\\work\\project');
});

function snapshotWithElements() {
  return {
    url: 'https://example.com',
    title: 'Example',
    content: { markdown: '# Example', truncated: false },
    elements: [{ uid: 'button-1', role: 'button', name: 'Continue', tag: 'button' }],
  };
}
