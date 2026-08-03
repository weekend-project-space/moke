import { createRouter, type RouterSecurityOptions } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { registerBrowserRoutes } from './browser.js';
import { registerAttachmentRoutes } from './attachments.js';
import { registerHealthRoutes } from './health.js';
import { registerRunRoutes } from './runs.js';
import { registerSettingRoutes } from './settings.js';
import { registerSessionRoutes } from './sessions.js';
import { registerToolRoutes } from './tools.js';
import { registerMessagingRoutes } from './messaging.js';
import { registerWeixinRoutes } from './weixin.js';
import { registerFeishuRoutes } from './feishu.js';
import { registerScheduledTaskRoutes } from './scheduled-tasks.js';

export function createRoutes(context: RoutesContext, security?: RouterSecurityOptions) {
  const router = createRouter<RoutesContext>(security);

  registerHealthRoutes(router);
  registerToolRoutes(router);
  registerBrowserRoutes(router);
  registerAttachmentRoutes(router);
  registerSessionRoutes(router);
  registerSettingRoutes(router);
  registerRunRoutes(router);
  registerMessagingRoutes(router);
  registerWeixinRoutes(router);
  registerFeishuRoutes(router);
  registerScheduledTaskRoutes(router);

  return router.handler(context);
}
