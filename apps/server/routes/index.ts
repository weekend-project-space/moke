import { createRouter } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { registerBrowserRoutes } from './browser.js';
import { registerHealthRoutes } from './health.js';
import { registerRunRoutes } from './runs.js';
import { registerSessionRoutes } from './sessions.js';
import { registerToolRoutes } from './tools.js';

export function createRoutes(context: RoutesContext) {
  const router = createRouter<RoutesContext>();

  registerHealthRoutes(router);
  registerToolRoutes(router);
  registerBrowserRoutes(router);
  registerSessionRoutes(router);
  registerRunRoutes(router);

  return router.handler(context);
}
