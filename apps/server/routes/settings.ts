import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';

export function registerSettingRoutes(router: Router<RoutesContext>) {
  router.get('/api/settings', ({ context, json }) =>
    json(200, context.settingsService.get()),
  );

  router.patch('/api/settings/model-providers', async ({ body, context, json }) =>
    json(200, context.settingsService.updateModelProviders(await body())),
  );

  router.post('/api/settings/model/test', async ({ body, context, json }) =>
    json(200, await context.settingsService.testModel(await body())),
  );

  router.post('/api/settings/model/list', async ({ body, context, json }) =>
    json(200, await context.settingsService.listModels(await body())),
  );

  router.get('/api/settings/permissions', ({ context, json }) =>
    json(200, {
      workspace_roots: context.permissionsService.listWorkspaceRoots(),
    }),
  );

  router.post('/api/settings/permissions/revoke', async ({ body, context, json }) => {
    const requestBody = await body();
    const root = typeof requestBody.path === 'string' ? requestBody.path : '';
    if (!root) throw new HttpError(400, 'BAD_REQUEST', 'path is required');

    if (!context.permissionsService.revokeWorkspaceRoot(root)) {
      throw new HttpError(404, 'PERMISSION_NOT_FOUND', 'Permission not found');
    }

    return json(200, {
      workspace_roots: context.permissionsService.listWorkspaceRoots(),
    });
  });
}
