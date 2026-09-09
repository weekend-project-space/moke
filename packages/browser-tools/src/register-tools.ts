import type { ToolRegistry } from '@moke/agent-runtime';
import type { BrowserBackend } from './browser-backend.js';
import {
  createClickTool,
  createCloseTabTool,
  createNewTabTool,
  createEvaluateTool,
  createFillFormTool,
  createFillTool,
  createHandleDialogTool,
  createHideBrowserTool,
  createHoverTool,
  createListTabsTool,
  createNavigateTool,
  createPressTool,
  createResizeViewportTool,
  createSwitchTabTool,
  createShowBrowserTool,
  createScreenshotTool,
  createSnapshotTool,
  createTypeTool,
  createUploadFileTool,
  createWaitForTextTool,
} from './page-tools.js';

export function registerBrowserTools(toolRegistry: ToolRegistry, browser: BrowserBackend) {
  return toolRegistry
    .register(createListTabsTool(browser))
    .register(createNewTabTool(browser))
    .register(createSwitchTabTool(browser))
    .register(createCloseTabTool(browser))
    .register(createNavigateTool(browser))
    .register(createEvaluateTool(browser))
    .register(createSnapshotTool(browser))
    .register(createScreenshotTool(browser))
    .register(createClickTool(browser))
    .register(createHoverTool(browser))
    .register(createFillTool(browser))
    .register(createFillFormTool(browser))
    .register(createUploadFileTool(browser))
    .register(createWaitForTextTool(browser))
    .register(createPressTool(browser))
    .register(createTypeTool(browser))
    .register(createHandleDialogTool(browser))
    .register(createResizeViewportTool(browser))
    .register(createShowBrowserTool(browser))
    .register(createHideBrowserTool(browser));
}
