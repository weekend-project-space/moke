import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { dingtalkLoginStartSchema, idParamsSchema } from './schemas.js';
import { parseBody, parseParams } from '../http/validation.js';

export function registerDingTalkRoutes(router: Router<RoutesContext>) {
  router.post('/api/messaging/dingtalk/logins', async ({ body, context, json }) => {
    await parseBody(body, dingtalkLoginStartSchema);
    return json(201, { login: await context.dingtalkLoginService.start() });
  });

  router.get('/api/messaging/dingtalk/logins/:id', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    try {
      return json(200, { login: await context.dingtalkLoginService.get(id) });
    } catch (error) {
      throw new HttpError(404, 'DINGTALK_LOGIN_NOT_FOUND', error instanceof Error ? error.message : 'DingTalk login not found');
    }
  });

  router.delete('/api/messaging/dingtalk/logins/:id', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    try {
      context.dingtalkLoginService.cancel(id);
      return json(204, undefined);
    } catch (error) {
      throw new HttpError(404, 'DINGTALK_LOGIN_NOT_FOUND', error instanceof Error ? error.message : 'DingTalk login not found');
    }
  });
}
