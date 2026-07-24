import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { idParamsSchema, messagingConnectionCreateSchema, messagingConnectionUpdateSchema } from './schemas.js';
import { parseBody, parseParams } from '../http/validation.js';

export function registerMessagingRoutes(router: Router<RoutesContext>) {
  router.get('/api/messaging/connections', ({ context, json }) =>
    json(200, { connections: context.messagingRuntime.listConnections() }),
  );

  router.post('/api/messaging/connections', async ({ body, context, json }) => {
    const input = await parseBody(body, messagingConnectionCreateSchema);
    const connection = await context.messagingRuntime.createConnection(input);
    return json(201, { connection });
  });

  router.get('/api/messaging/connections/:id', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const connection = context.messagingRuntime.getConnection(id);
    if (!connection) throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    return json(200, { connection });
  });

  router.patch('/api/messaging/connections/:id', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const input = await parseBody(body, messagingConnectionUpdateSchema);
    const current = context.messagingRuntime.getConnection(id);
    if (!current) {
      throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    }
    if ((input.allowedUserIds !== undefined || input.cardTemplateId !== undefined) && current.platform !== 'dingtalk') {
      throw new HttpError(400, 'MESSAGING_CONFIG_NOT_SUPPORTED', 'These settings are only available for DingTalk');
    }
    const connection = await context.messagingRuntime.updateConnection({ id, ...input });
    return json(200, { connection });
  });

  router.delete('/api/messaging/connections/:id', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    if (!context.messagingRuntime.getConnection(id)) {
      throw new HttpError(404, 'MESSAGING_CONNECTION_NOT_FOUND', 'Messaging connection not found');
    }
    await context.messagingRuntime.removeConnection(id);
    return json(204, undefined);
  });
}
