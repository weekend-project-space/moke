import type { RoutesContext } from './context.js';
import { rawResponse, type Router } from '../http/router.js';
import { parseBody } from '../http/validation.js';
import { browserRespondSchema } from './schemas.js';

export function registerBrowserRoutes(router: Router<RoutesContext>) {
  router.get('/api/browser/connect', ({ context, raw }) => {
    context.browserBridge.connect(raw.res);
    raw.req.on('close', () => context.browserBridge.disconnect(raw.res));
    return rawResponse();
  });

  router.post('/api/browser/respond', async ({ body, context, json }) => {
    const requestBody = await parseBody(body, browserRespondSchema);

    const accepted = context.browserBridge.respond(requestBody.id, {
      ok: requestBody.ok,
      result: requestBody.result,
      error: requestBody.error,
    });

    return json(accepted ? 200 : 404, { accepted });
  });
}
