import { z } from 'zod';

import type { RuntimeTool } from '../../agent-runtime/src/index.js';
import type { BrowserBackend } from './browser-backend.js';

const emptySchema = z.object({});

const createPageSchema = z.object({
  url: z.string().min(1).optional(),
  visible: z.boolean().optional(),
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

export function createListPagesTool(browser: BrowserBackend): RuntimeTool<typeof emptySchema> {
  return {
    name: 'list_pages',
    description: 'List all open in-app browser tabs and the active tab state.',
    risk: 'safe',
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
    risk: 'safe',
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
    risk: 'safe',
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
    risk: 'safe',
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
    risk: 'safe',
    schema: navigatePageSchema,
    async handler(input) {
      return browser.navigatePage(input);
    },
  };
}

export function createShowBrowserTool(browser: BrowserBackend): RuntimeTool<typeof emptySchema> {
  return {
    name: 'show_browser',
    description: 'Show the in-app browser panel.',
    risk: 'safe',
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
    risk: 'safe',
    schema: emptySchema,
    async handler() {
      return browser.hideBrowser();
    },
  };
}
