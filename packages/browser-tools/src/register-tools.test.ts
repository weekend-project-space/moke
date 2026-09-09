import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '@moke/agent-runtime';
import type { BrowserBackend } from './browser-backend.js';
import { registerBrowserTools } from './register-tools.js';

test('browser registry exposes exactly the new tool names without aliases', () => {
  const registry = new ToolRegistry();
  registerBrowserTools(registry, {} as BrowserBackend);
  assert.deepEqual(registry.list().map((tool) => tool.name).sort(), [
    'list_tabs', 'new_tab', 'switch_tab', 'close_tab', 'navigate',
    'evaluate', 'snapshot', 'screenshot', 'click', 'hover', 'fill',
    'fill_form', 'upload_file', 'wait_for_text', 'press', 'type',
    'handle_dialog', 'resize_viewport', 'show_browser', 'hide_browser',
  ].sort());
});
