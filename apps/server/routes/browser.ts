import type { RoutesContext } from './context.js';
import { HttpError, rawResponse, type Router } from '../http/router.js';

export function registerBrowserRoutes(router: Router<RoutesContext>) {
  router.get('/api/browser/connect', ({ context, raw }) => {
    context.browserBridge.connect(raw.res);
    raw.req.on('close', () => context.browserBridge.disconnect(raw.res));
    return rawResponse();
  });

  router.post('/api/browser/respond', async ({ body, context, json }) => {
    const requestBody = await body();
    const id = typeof requestBody.id === 'string' ? requestBody.id : '';
    if (!id) throw new HttpError(400, 'BAD_REQUEST', 'id is required');

    const accepted = context.browserBridge.respond(id, {
      ok: requestBody.ok !== false,
      result: typeof requestBody.result === 'object' && requestBody.result !== null
        ? requestBody.result as Record<string, unknown>
        : {},
      error: typeof requestBody.error === 'string' ? requestBody.error : undefined,
    });

    return json(accepted ? 200 : 404, { accepted });
  });
}
