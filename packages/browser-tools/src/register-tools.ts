import type { ToolRegistry } from '../../agent-runtime/src/index.js';
import type { BrowserBackend } from './browser-backend.js';
import {
  createClosePageTool,
  createCreatePageTool,
  createHideBrowserTool,
  createListPagesTool,
  createNavigatePageTool,
  createSelectPageTool,
  createShowBrowserTool,
} from './page-tools.js';

export function registerBrowserTools(toolRegistry: ToolRegistry, browser: BrowserBackend) {
  return toolRegistry
    .register(createListPagesTool(browser))
    .register(createCreatePageTool(browser))
    .register(createSelectPageTool(browser))
    .register(createClosePageTool(browser))
    .register(createNavigatePageTool(browser))
    .register(createShowBrowserTool(browser))
    .register(createHideBrowserTool(browser));
}
