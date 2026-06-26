import type { ToolRegistry } from '../../agent-runtime/src/index.js';
import type { BrowserBackend } from './browser-backend.js';
import {
  createClickTool,
  createClosePageTool,
  createCreatePageTool,
  createEvaluateScriptTool,
  createFillFormTool,
  createFillTool,
  createHandleDialogTool,
  createHideBrowserTool,
  createHoverTool,
  createListPagesTool,
  createNavigatePageTool,
  createPressKeyTool,
  createResizePageTool,
  createSelectPageTool,
  createShowBrowserTool,
  createTakeScreenshotTool,
  createTakeSnapshotTool,
  createTypeTextTool,
  createUploadFileTool,
  createWaitForTool,
} from './page-tools.js';

export function registerBrowserTools(toolRegistry: ToolRegistry, browser: BrowserBackend) {
  return toolRegistry
    .register(createListPagesTool(browser))
    .register(createCreatePageTool(browser))
    .register(createSelectPageTool(browser))
    .register(createClosePageTool(browser))
    .register(createNavigatePageTool(browser))
    .register(createEvaluateScriptTool(browser))
    .register(createTakeSnapshotTool(browser))
    .register(createTakeScreenshotTool(browser))
    .register(createClickTool(browser))
    .register(createHoverTool(browser))
    .register(createFillTool(browser))
    .register(createFillFormTool(browser))
    .register(createUploadFileTool(browser))
    .register(createWaitForTool(browser))
    .register(createPressKeyTool(browser))
    .register(createTypeTextTool(browser))
    .register(createHandleDialogTool(browser))
    .register(createResizePageTool(browser))
    .register(createShowBrowserTool(browser))
    .register(createHideBrowserTool(browser));
}
