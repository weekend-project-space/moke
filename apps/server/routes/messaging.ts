import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { idParamsSchema, messagingConnectionStatusSchema } from './schemas.js';
import { parseBody, parseParams } from '../http/validation.js';

export function registerMessagingRoutes(router: Router<RoutesContext>) {
  router.get('/api/messaging/connections', ({ context, json }) =>
    json(200, { connections: context.messagingStore.listConnections() }),
  );

  router.get('/api/messaging/connections/:id', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const connection = context.messagingStore.getPublicConnection(id);
    if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    return json(200, { connection });
  });

  router.post('/api/messaging/connections/:id/start', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const connection = await context.messagingConnectionManager.start(id);
    if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    return json(200, { connection });
  });

  router.post('/api/messaging/connections/:id/stop', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const connection = await context.messagingConnectionManager.stop(id);
    if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    return json(200, { connection });
  });

  router.post('/api/messaging/connections/:id/reauthorize', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    if (!context.messagingStore.getConnection(id)) {
      throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    }
    await context.messagingConnectionManager.stop(id);
    return json(201, { login: await context.weixinLoginService.start({ connectionId: id }) });
  });

  router.post('/api/messaging/connections/:id/status', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const { enabled } = await parseBody(body, messagingConnectionStatusSchema);
    const connection = context.messagingStore.setConnectionEnabled(id, enabled);
    if (enabled) await context.messagingConnectionManager.start(id);
    else await context.messagingConnectionManager.stop(id);
    return json(200, { connection: context.messagingStore.getPublicConnection(connection.id) });
  });

  router.post('/api/messaging/connections/:id/delete', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    if (!context.messagingStore.getConnection(id)) {
      throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    }
    await context.messagingConnectionManager.remove(id);
    return json(200, { deleted: true });
  });
}
