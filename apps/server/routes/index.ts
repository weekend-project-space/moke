import { createRouter } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { registerBrowserRoutes } from './browser.js';
import { registerAttachmentRoutes } from './attachments.js';
import { registerHealthRoutes } from './health.js';
import { registerRunRoutes } from './runs.js';
import { registerSettingRoutes } from './settings.js';
import { registerSessionRoutes } from './sessions.js';
import { registerToolRoutes } from './tools.js';

export function createRoutes(context: RoutesContext) {
  const router = createRouter<RoutesContext>();

  registerHealthRoutes(router);
  registerToolRoutes(router);
  registerBrowserRoutes(router);
  registerAttachmentRoutes(router);
  registerSessionRoutes(router);
  registerSettingRoutes(router);
  registerRunRoutes(router);

  return router.handler(context);
}
