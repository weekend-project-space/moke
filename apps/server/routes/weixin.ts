import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { idParamsSchema, weixinLoginStartSchema, weixinVerifySchema } from './schemas.js';
import { parseBody, parseParams } from '../http/validation.js';

export function registerWeixinRoutes(router: Router<RoutesContext>) {
  router.post('/api/messaging/weixin/logins', async ({ body, context, json }) =>
    json(201, { login: await context.weixinLoginService.start(await parseBody(body, weixinLoginStartSchema)) }),
  );

  router.get('/api/messaging/weixin/logins/:id', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    try {
      return json(200, { login: await context.weixinLoginService.get(id) });
    } catch (error) {
      throw new HttpError(404, 'WEIXIN_LOGIN_NOT_FOUND', error instanceof Error ? error.message : 'Weixin login not found');
    }
  });

  router.post('/api/messaging/weixin/logins/:id/verify', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    try {
      return json(200, { login: await context.weixinLoginService.verify(id, (await parseBody(body, weixinVerifySchema)).code) });
    } catch (error) {
      throw new HttpError(404, 'WEIXIN_LOGIN_NOT_FOUND', error instanceof Error ? error.message : 'Weixin login not found');
    }
  });

  router.post('/api/messaging/weixin/logins/:id/cancel', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    try {
      return json(200, { login: context.weixinLoginService.cancel(id) });
    } catch (error) {
      throw new HttpError(404, 'WEIXIN_LOGIN_NOT_FOUND', error instanceof Error ? error.message : 'Weixin login not found');
    }
  });
}
