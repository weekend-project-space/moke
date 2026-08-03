import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { feishuLoginStartSchema, idParamsSchema } from './schemas.js';
import { parseBody, parseParams } from '../http/validation.js';

export function registerFeishuRoutes(router: Router<RoutesContext>) {
  router.post('/api/messaging/feishu/logins', async ({ body, context, json }) =>
    json(201, { login: await context.feishuLoginService.start(await parseBody(body, feishuLoginStartSchema)) }),
  );

  router.get('/api/messaging/feishu/logins/:id', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    try {
      return json(200, { login: await context.feishuLoginService.get(id) });
    } catch (error) {
      throw new HttpError(404, 'FEISHU_LOGIN_NOT_FOUND', error instanceof Error ? error.message : 'Feishu login not found');
    }
  });

  router.delete('/api/messaging/feishu/logins/:id', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    try {
      context.feishuLoginService.cancel(id);
      return json(204, undefined);
    } catch (error) {
      throw new HttpError(404, 'FEISHU_LOGIN_NOT_FOUND', error instanceof Error ? error.message : 'Feishu login not found');
    }
  });
}
