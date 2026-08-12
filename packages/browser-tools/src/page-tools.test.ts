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
