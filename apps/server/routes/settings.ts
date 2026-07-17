import { HttpError, type Router } from '../http/router.js';
import { SkillRepositoryError } from '@moke/agent-skills';
import type { RoutesContext } from './context.js';
import {
  idParamsSchema,
  mcpSettingsSchema,
  providerInputSchema,
  revokePermissionSchema,
  runtimeSettingsSchema,
  skillDraftSchema,
  skillStatusSchema,
} from './schemas.js';
import { parseBody, parseParams } from '../http/validation.js';

export function registerSettingRoutes(router: Router<RoutesContext>) {
  router.get('/api/settings', ({ context, json }) =>
    json(200, context.settingsService.get()),
  );

  router.patch('/api/settings/model-providers', async ({ body, context, json }) =>
    json(200, context.settingsService.updateModelProviders(await parseBody(body, runtimeSettingsSchema))),
  );

  router.post('/api/settings/model/test', async ({ body, context, json }) =>
    json(200, await context.settingsService.testModel(await parseBody(body, providerInputSchema))),
  );

  router.post('/api/settings/model/list', async ({ body, context, json }) =>
    json(200, await context.settingsService.listModels(await parseBody(body, providerInputSchema))),
  );

  router.get('/api/settings/skills', async ({ context, json }) =>
    json(200, await withSkillErrors(() => context.skillSettingsService.list())),
  );

  router.get('/api/settings/skills/:id', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    return json(200, await withSkillErrors(() => context.skillSettingsService.get(id)));
  });

  router.post('/api/settings/skills', async ({ body, context, json }) =>
    json(201, await withSkillErrors(async () => context.skillSettingsService.create(await parseBody(body, skillDraftSchema)))),
  );

  router.patch('/api/settings/skills/:id', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    return json(200, await withSkillErrors(async () => context.skillSettingsService.update(id, await parseBody(body, skillDraftSchema))));
  });

  router.post('/api/settings/skills/:id/status', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    return json(200, await withSkillErrors(async () => context.skillSettingsService.setEnabled(id, await parseBody(body, skillStatusSchema))));
  });

  router.post('/api/settings/skills/:id/delete', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    return json(200, await withSkillErrors(() => context.skillSettingsService.remove(id)));
  });

  router.post('/api/settings/skills/validate', async ({ body, context, json }) =>
    json(200, await withSkillErrors(async () => context.skillSettingsService.validate(await parseBody(body, skillDraftSchema)))),
  );

  router.get('/api/settings/mcp', ({ context, json }) =>
    json(200, context.mcpSettingsService.get()),
  );

  router.post('/api/settings/mcp/validate', async ({ body, context, json }) =>
    json(200, context.mcpSettingsService.validate(await parseBody(body, mcpSettingsSchema))),
  );

  router.patch('/api/settings/mcp', async ({ body, context, json }) =>
    json(200, context.mcpSettingsService.save(await parseBody(body, mcpSettingsSchema))),
  );

  router.get('/api/settings/permissions', ({ context, json }) =>
    json(200, {
      workspace_roots: context.permissionsService.listWorkspaceRoots(),
    }),
  );

  router.post('/api/settings/permissions/revoke', async ({ body, context, json }) => {
    const { path: root } = await parseBody(body, revokePermissionSchema);

    if (!context.permissionsService.revokeWorkspaceRoot(root)) {
      throw new HttpError(404, 'PERMISSION_NOT_FOUND', 'Permission not found');
    }

    return json(200, {
      workspace_roots: context.permissionsService.listWorkspaceRoots(),
    });
  });
}

async function withSkillErrors<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof SkillRepositoryError)) throw error;
    const status = error.code === 'SKILL_NOT_FOUND'
      ? 404
      : error.code === 'SKILL_EXISTS' || error.code === 'SKILL_NAME_EXISTS'
        ? 409
        : 400;
    throw new HttpError(status, error.code, error.message);
  }
}
