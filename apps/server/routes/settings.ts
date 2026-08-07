import { HttpError, type Router } from '../http/router.js';
import { SkillRepositoryError } from '@moke/agent-skills';
import { McpSettingsError } from '../services/mcp-settings-service.js';
import type { RoutesContext } from './context.js';
import {
  idParamsSchema,
  mcpServerCreateSchema,
  mcpServerStatusSchema,
  mcpServerUpdateSchema,
  mcpSettingsSchema,
  providerInputSchema,
  revokePermissionSchema,
  runtimeSettingsSchema,
  skillImportSchema,
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

  router.post('/api/settings/skills/import', async ({ body, context, json }) =>
    json(201, await withSkillErrors(async () => context.skillSettingsService.importFromPath(await parseBody(body, skillImportSchema)))),
  );

  router.patch('/api/settings/skills/:id/status', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    return json(200, await withSkillErrors(async () => context.skillSettingsService.setEnabled(id, await parseBody(body, skillStatusSchema))));
  });

  router.delete('/api/settings/skills/:id', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    return json(200, await withSkillErrors(() => context.skillSettingsService.remove(id)));
  });

  router.get('/api/settings/mcp', ({ context, json }) =>
    json(200, context.mcpSettingsService.get()),
  );

  router.patch('/api/settings/mcp', async ({ body, context, json }) =>
    json(200, context.mcpSettingsService.save(await parseBody(body, mcpSettingsSchema))),
  );

  router.post('/api/settings/mcp/servers', async ({ body, context, json }) => {
    const input = await parseBody(body, mcpServerCreateSchema);
    return json(201, await withMcpErrors(() => context.mcpSettingsService.addServer(input)));
  });

  router.patch('/api/settings/mcp/servers/:id', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const input = await parseBody(body, mcpServerUpdateSchema);
    return json(200, await withMcpErrors(() => context.mcpSettingsService.updateServer(id, input)));
  });

  router.patch('/api/settings/mcp/servers/:id/status', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const input = await parseBody(body, mcpServerStatusSchema);
    return json(200, await withMcpErrors(() => context.mcpSettingsService.setServerEnabled(id, input.enabled)));
  });

  router.delete('/api/settings/mcp/servers/:id', async ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    return json(200, await withMcpErrors(() => context.mcpSettingsService.removeServer(id)));
  });

  router.post('/api/settings/mcp/:id/trust', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    if (!context.mcpSettingsService.trust(id)) {
      throw new HttpError(404, 'MCP_SERVER_NOT_FOUND', 'MCP server not found');
    }
    return json(200, context.mcpSettingsService.get());
  });

  router.delete('/api/settings/mcp/:id/trust', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    if (!context.mcpSettingsService.revokeTrust(id)) {
      throw new HttpError(404, 'MCP_SERVER_TRUST_NOT_FOUND', 'MCP server trust not found');
    }
    return json(200, context.mcpSettingsService.get());
  });

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

async function withMcpErrors<T>(action: () => T | Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof McpSettingsError)) throw error;
    const status = error.code === 'MCP_SERVER_NOT_FOUND' ? 404 : 409;
    throw new HttpError(status, error.code, error.message);
  }
}
