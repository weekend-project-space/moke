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
  interaction: z.enum(['act', 'observe']).default('act').describe(
    'act includes element UIDs; observe omits them.',
  ),
});

const takeScreenshotSchema = z.object({
  pageId: z.number().int().positive().optional(),
  path: z.string().min(1).optional(),
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

export function createListTabsTool(browser: BrowserBackend): RuntimeTool<typeof emptySchema> {
  return {
    name: 'list_tabs',
    description: 'List browser tabs, page IDs, and the active tab.',
    approval: 'none',
    schema: emptySchema,
    async handler() {
      return browser.listPages();
    },
  };
}

export function createNewTabTool(browser: BrowserBackend): RuntimeTool<typeof createPageSchema> {
  return {
    name: 'new_tab',
    description: 'Create a browser tab without expanding the panel.',
    approval: 'none',
    schema: createPageSchema,
    async handler(input) {
      return browser.createPage(input);
    },
  };
}

export function createSwitchTabTool(browser: BrowserBackend): RuntimeTool<typeof pageIdSchema> {
  return {
    name: 'switch_tab',
    description: 'Select a browser tab without expanding the panel.',
    approval: 'none',
    schema: pageIdSchema,
    async handler(input) {
      return browser.selectPage(input);
    },
  };
}

export function createCloseTabTool(browser: BrowserBackend): RuntimeTool<typeof pageIdSchema> {
  return {
    name: 'close_tab',
    description: 'Close a browser tab by page ID.',
    approval: 'none',
    schema: pageIdSchema,
    async handler(input) {
      return browser.closePage(input);
    },
  };
}

export function createNavigateTool(browser: BrowserBackend): RuntimeTool<typeof navigatePageSchema> {
  return {
    name: 'navigate',
    description: 'Open a URL, go back or forward, or reload a browser tab.',
    approval: 'none',
    schema: navigatePageSchema,
    async handler(input) {
      return browser.navigatePage(input);
    },
  };
}

export function createEvaluateTool(browser: BrowserBackend): RuntimeTool<typeof evaluateScriptSchema> {
  return {
    name: 'evaluate',
    description: 'Run a synchronous JavaScript function in a browser page.',
    approval: 'none',
    schema: evaluateScriptSchema,
    async handler(input) {
      return browser.evaluateScript(input);
    },
  };
}

export function createSnapshotTool(browser: BrowserBackend): RuntimeTool<typeof takeSnapshotSchema> {
  return {
    name: 'snapshot',
    description:
      'Read page content and actionable element UIDs.',
    approval: 'none',
    schema: takeSnapshotSchema,
    async handler({ interaction, ...input }, context) {
      const result = await browser.takeSnapshot(input, context.workspace);
      if (interaction === 'observe' && result.snapshot) {
        const { elements: _elements, ...snapshot } = result.snapshot;
        return { ...result, snapshot };
      }
      return result;
    },
  };
}

export function createScreenshotTool(browser: BrowserBackend): RuntimeTool<typeof takeScreenshotSchema> {
  return {
    name: 'screenshot',
    description: 'Capture a browser viewport, full page, or snapshot element as a PNG.',
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
    description: 'Click or double-click a browser element by snapshot UID.',
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
    description: 'Dispatch hover events to a browser element by snapshot UID.',
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
    description: 'Replace a browser element\'s value by snapshot UID.',
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
    description: 'Set multiple browser form values by snapshot UID.',
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
    description: 'Attach a local file to a browser file input by snapshot UID.',
    approval: 'none',
    schema: uploadFileSchema,
    async handler(input) {
      return browser.uploadFile(input);
    },
  };
}

export function createWaitForTextTool(browser: BrowserBackend): RuntimeTool<typeof waitForSchema> {
  return {
    name: 'wait_for_text',
    description: 'Wait for any supplied text to appear in a browser page.',
    approval: 'none',
    schema: waitForSchema,
    async handler(input) {
      return browser.waitFor(input);
    },
  };
}

export function createPressTool(browser: BrowserBackend): RuntimeTool<typeof pressKeySchema> {
  return {
    name: 'press',
    description: 'Send synthetic key events to the focused browser element.',
    approval: 'none',
    schema: pressKeySchema,
    async handler(input) {
      return browser.pressKey(input);
    },
  };
}

export function createTypeTool(browser: BrowserBackend): RuntimeTool<typeof typeTextSchema> {
  return {
    name: 'type',
    description: 'Append text to the focused editable browser element.',
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
    description: 'Accept or dismiss a browser dialog.',
    approval: 'none',
    schema: handleDialogSchema,
    async handler(input) {
      return browser.handleDialog(input);
    },
  };
}

export function createResizeViewportTool(browser: BrowserBackend): RuntimeTool<typeof resizePageSchema> {
  return {
    name: 'resize_viewport',
    description: 'Resize the embedded browser viewport.',
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
    description: 'Expand the in-app browser panel and show its active browser tab.',
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
    description: 'Hide the in-app browser panel without closing its tabs.',
    approval: 'none',
    schema: emptySchema,
    async handler() {
      return browser.hideBrowser();
    },
  };
}
