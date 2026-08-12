import { z } from 'zod';

import type { RuntimeTool } from '@moke/agent-runtime';
import type { BrowserBackend } from './browser-backend.js';

const emptySchema = z.object({});

const createPageSchema = z.object({
  url: z.string().min(1).optional(),
});

const pageIdSchema = z.object({
  pageId: z.number().int().positive(),
});

const navigatePageSchema = z
  .object({
    pageId: z.number().int().positive().optional(),
    type: z.enum(['url', 'back', 'forward', 'reload']),
    url: z.string().min(1).optional(),
    timeout: z.number().int().positive().max(120000).optional(),
    ignoreCache: z.boolean().optional(),
  })
  .refine((input) => input.type !== 'url' || Boolean(input.url), {
    path: ['url'],
    message: 'url is required when type is url',
  });

const evaluateScriptSchema = z.object({
  pageId: z.number().int().positive().optional(),
  function: z.string().min(1),
  args: z.array(z.unknown()).optional(),
  dialogAction: z.string().optional(),
});

const takeSnapshotSchema = z.object({
  pageId: z.number().int().positive().optional(),
  verbose: z.boolean().optional(),
  filePath: z.string().min(1).optional(),
});

const takeScreenshotSchema = z.object({
  pageId: z.number().int().positive().optional(),
  path: z.string().min(1).optional().describe('Workspace-relative output path ending in .png.'),
  fullPage: z.boolean().optional(),
  uid: z.string().min(1).optional(),
});

const elementActionSchema = z.object({
  pageId: z.number().int().positive().optional(),
  uid: z.string().min(1),
  includeSnapshot: z.boolean().optional(),
});

const clickSchema = elementActionSchema.extend({
  dblClick: z.boolean().optional(),
});

const hoverSchema = elementActionSchema;

const fillSchema = elementActionSchema.extend({
  value: z.string(),
});

const fillFormSchema = z.object({
  pageId: z.number().int().positive().optional(),
  elements: z.array(z.object({
    uid: z.string().min(1),
    value: z.string(),
  })).min(1),
  includeSnapshot: z.boolean().optional(),
});

const uploadFileSchema = elementActionSchema.extend({
  filePath: z.string().min(1),
});

const waitForSchema = z.object({
  pageId: z.number().int().positive().optional(),
  text: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  timeout: z.number().int().positive().max(120000).optional(),
});

const pressKeySchema = z.object({
  pageId: z.number().int().positive().optional(),
  key: z.string().min(1),
  includeSnapshot: z.boolean().optional(),
});

const typeTextSchema = z.object({
  pageId: z.number().int().positive().optional(),
  text: z.string(),
  submitKey: z.string().min(1).optional(),
});

const handleDialogSchema = z.object({
  pageId: z.number().int().positive().optional(),
  action: z.enum(['accept', 'dismiss']),
  promptText: z.string().optional(),
});

const resizePageSchema = z.object({
  pageId: z.number().int().positive().optional(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export function createListPagesTool(browser: BrowserBackend): RuntimeTool<typeof emptySchema> {
  return {
    name: 'list_pages',
    description: 'List all open in-app browser tabs and the active tab state.',
    approval: 'none',
    schema: emptySchema,
    async handler() {
      return browser.listPages();
    },
  };
}

export function createCreatePageTool(browser: BrowserBackend): RuntimeTool<typeof createPageSchema> {
  return {
    name: 'create_page',
    description: 'Create a new in-app browser tab, optionally loading a URL.',
    approval: 'none',
    schema: createPageSchema,
    async handler(input) {
      return browser.createPage(input);
    },
  };
}

export function createSelectPageTool(browser: BrowserBackend): RuntimeTool<typeof pageIdSchema> {
  return {
    name: 'select_page',
    description: 'Select an open in-app browser tab by page id.',
    approval: 'none',
    schema: pageIdSchema,
    async handler(input) {
      return browser.selectPage(input);
    },
  };
}

export function createClosePageTool(browser: BrowserBackend): RuntimeTool<typeof pageIdSchema> {
  return {
    name: 'close_page',
    description: 'Close an open in-app browser tab by page id.',
    approval: 'none',
    schema: pageIdSchema,
    async handler(input) {
      return browser.closePage(input);
    },
  };
}

export function createNavigatePageTool(browser: BrowserBackend): RuntimeTool<typeof navigatePageSchema> {
  return {
    name: 'navigate_page',
    description: 'Navigate the active in-app browser tab by URL, back, forward, or reload.',
    approval: 'none',
    schema: navigatePageSchema,
    async handler(input) {
      return browser.navigatePage(input);
    },
  };
}

export function createEvaluateScriptTool(browser: BrowserBackend): RuntimeTool<typeof evaluateScriptSchema> {
  return {
    name: 'evaluate_script',
    description: 'Execute a JavaScript function in the active in-app browser page.',
    approval: 'none',
    schema: evaluateScriptSchema,
    async handler(input) {
      return browser.evaluateScript(input);
    },
  };
}

export function createTakeSnapshotTool(browser: BrowserBackend): RuntimeTool<typeof takeSnapshotSchema> {
  return {
    name: 'take_snapshot',
    description:
      'Return a lightweight snapshot of the active in-app browser page, including actionable elements and page content as Markdown.',
    approval: 'none',
    schema: takeSnapshotSchema,
    async handler(input, context) {
      return browser.takeSnapshot(input, context.workspace);
    },
  };
}

export function createTakeScreenshotTool(browser: BrowserBackend): RuntimeTool<typeof takeScreenshotSchema> {
  return {
    name: 'take_screenshot',
    description: 'Capture a PNG screenshot of the active in-app browser viewport, full page, or one snapshot element.',
    approval: 'none',
    schema: takeScreenshotSchema,
    async handler(input, context) {
      return browser.takeScreenshot(input, context.workspace);
    },
  };
}

export function createClickTool(browser: BrowserBackend): RuntimeTool<typeof clickSchema> {
  return {
    name: 'click',
    description: 'Click or double-click an element from the latest browser snapshot by uid.',
    approval: 'none',
    schema: clickSchema,
    async handler(input) {
      return browser.click(input);
    },
  };
}

export function createHoverTool(browser: BrowserBackend): RuntimeTool<typeof hoverSchema> {
  return {
    name: 'hover',
    description: 'Hover an element from the latest browser snapshot by uid.',
    approval: 'none',
    schema: hoverSchema,
    async handler(input) {
      return browser.hover(input);
    },
  };
}

export function createFillTool(browser: BrowserBackend): RuntimeTool<typeof fillSchema> {
  return {
    name: 'fill',
    description: 'Fill an input, textarea, editable element, or select by browser snapshot uid.',
    approval: 'none',
    schema: fillSchema,
    async handler(input) {
      return browser.fill(input);
    },
  };
}

export function createFillFormTool(browser: BrowserBackend): RuntimeTool<typeof fillFormSchema> {
  return {
    name: 'fill_form',
    description: 'Fill multiple browser form elements by snapshot uid.',
    approval: 'none',
    schema: fillFormSchema,
    async handler(input) {
      return browser.fillForm(input);
    },
  };
}

export function createUploadFileTool(browser: BrowserBackend): RuntimeTool<typeof uploadFileSchema> {
  return {
    name: 'upload_file',
    description: 'Attach a local file to a file input from the latest browser snapshot by uid.',
    approval: 'none',
    schema: uploadFileSchema,
    async handler(input) {
      return browser.uploadFile(input);
    },
  };
}

export function createWaitForTool(browser: BrowserBackend): RuntimeTool<typeof waitForSchema> {
  return {
    name: 'wait_for',
    description: 'Wait until one of the target texts appears in the active browser page.',
    approval: 'none',
    schema: waitForSchema,
    async handler(input) {
      return browser.waitFor(input);
    },
  };
}

export function createPressKeyTool(browser: BrowserBackend): RuntimeTool<typeof pressKeySchema> {
  return {
    name: 'press_key',
    description: 'Dispatch a keyboard key or key combination to the active browser element.',
    approval: 'none',
    schema: pressKeySchema,
    async handler(input) {
      return browser.pressKey(input);
    },
  };
}

export function createTypeTextTool(browser: BrowserBackend): RuntimeTool<typeof typeTextSchema> {
  return {
    name: 'type_text',
    description: 'Type text into the active editable browser element, optionally submitting with a key.',
    approval: 'none',
    schema: typeTextSchema,
    async handler(input) {
      return browser.typeText(input);
    },
  };
}

export function createHandleDialogTool(browser: BrowserBackend): RuntimeTool<typeof handleDialogSchema> {
  return {
    name: 'handle_dialog',
    description: 'Accept or dismiss the active browser dialog.',
    approval: 'none',
    schema: handleDialogSchema,
    async handler(input) {
      return browser.handleDialog(input);
    },
  };
}

export function createResizePageTool(browser: BrowserBackend): RuntimeTool<typeof resizePageSchema> {
  return {
    name: 'resize_page',
    description: 'Resize the active in-app browser page viewport.',
    approval: 'none',
    schema: resizePageSchema,
    async handler(input) {
      return browser.resizePage(input);
    },
  };
}

export function createShowBrowserTool(browser: BrowserBackend): RuntimeTool<typeof emptySchema> {
  return {
    name: 'show_browser',
    description: 'Show the in-app browser panel.',
    approval: 'none',
    schema: emptySchema,
    async handler() {
      return browser.showBrowser();
    },
  };
}

export function createHideBrowserTool(browser: BrowserBackend): RuntimeTool<typeof emptySchema> {
  return {
    name: 'hide_browser',
    description: 'Hide the in-app browser panel.',
    approval: 'none',
    schema: emptySchema,
    async handler() {
      return browser.hideBrowser();
    },
  };
}
