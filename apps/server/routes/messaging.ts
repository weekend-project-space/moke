import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { idParamsSchema, messagingConnectionCreateSchema, messagingConnectionUpdateSchema } from './schemas.js';
import { parseBody, parseParams } from '../http/validation.js';

export function registerMessagingRoutes(router: Router<RoutesContext>) {
  router.get('/api/messaging/connections', ({ context, json }) =>
    json(200, { connections: context.messagingStore.listConnections() }),
  );

  router.post('/api/messaging/connections', async ({ body, context, json }) => {
    const input = await parseBody(body, messagingConnectionCreateSchema);
    const connection = context.messagingStore.createDingTalkConnection(input.credentials);
    try {
      await context.messagingConnectionManager.start(connection.id);
    } catch (error) {
      const current = context.messagingStore.getConnection(connection.id);
      if (current && current.state !== 'error' && current.state !== 'reauth_required') {
        context.messagingStore.updateConnectionState(connection.id, {
          state: 'error',
          error: {
            code: 'MESSAGING_CONNECTION_START_FAILED',
            message: error instanceof Error ? error.message : 'Messaging connection failed to start',
          },
        });
      }
    }
    return json(201, { connection: context.messagingStore.getPublicConnection(connection.id) });
  });

  router.get('/api/messaging/connections/:id', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const connection = context.messagingStore.getPublicConnection(id);
    if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    return json(200, { connection });
  });

  router.patch('/api/messaging/connections/:id', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const { enabled } = await parseBody(body, messagingConnectionUpdateSchema);
    if (!context.messagingStore.getConnection(id)) {
      throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    }
    context.messagingStore.setConnectionEnabled(id, enabled);
    if (enabled) await context.messagingConnectionManager.start(id);
    else await context.messagingConnectionManager.stop(id);
    return json(200, { connection: context.messagingStore.getPublicConnection(id) });
  });

  router.delete('/api/messaging/connections/:id', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    if (!context.messagingStore.getConnection(id)) {
      throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    }
    await context.messagingConnectionManager.remove(id);
    return json(204, undefined);
  });
}
