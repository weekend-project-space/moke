import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { parseBody, parseQuery } from '../http/validation.js';
import { modelCapabilitiesQuerySchema, workspaceContextSchema, workspaceEntriesQuerySchema, workspaceSkillsQuerySchema } from './schemas.js';
import { DiscoveryServiceError } from '../services/discovery-service.js';

export function registerDiscoveryRoutes(router: Router<RoutesContext>) {
  router.post('/api/workspace/contexts', async ({ body, context, json }) => {
    const input = await parseBody(body, workspaceContextSchema);
    return json(201, context.discoveryService.createContext(input.root, input.ttl_ms));
  });

  router.get('/api/workspace/entries', async ({ context, json, query }) => {
    const input = parseQuery(query, workspaceEntriesQuerySchema);
    const session = input.session_id ? context.sessionStore.get(input.session_id) : undefined;
    if (input.session_id && !session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    try {
      const root = context.discoveryService.resolveContext(input.context_id, session?.env?.workspace.root, context.defaultWorkspaceRoot);
      return json(200, await context.discoveryService.listEntries(root, {
        path: input.path,
        query: input.query,
        includeDirectories: input.include_directories === 'true',
        limit: input.limit,
      }));
    } catch (error) { throw discoveryError(error); }
  });

  router.get('/api/workspace/skills', async ({ context, json, query }) => {
    const input = parseQuery(query, workspaceSkillsQuerySchema);
    const session = input.session_id ? context.sessionStore.get(input.session_id) : undefined;
    if (input.session_id && !session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    try {
      const root = context.discoveryService.resolveContext(input.context_id, session?.env?.workspace.root, context.defaultWorkspaceRoot);
      return json(200, await context.discoveryService.listSkills(root, input.enabled_only === 'true'));
    } catch (error) { throw discoveryError(error); }
  });

  router.get('/api/settings/model/capabilities', ({ context, json, query }) => {
    const input = parseQuery(query, modelCapabilitiesQuerySchema);
    return json(200, context.discoveryService.listModels(input.provider_id));
  });
}

function discoveryError(error: unknown) {
  if (error instanceof DiscoveryServiceError) return new HttpError(
    error.code === 'WORKSPACE_CONTEXT_NOT_FOUND' ? 404 : 400,
    error.code,
    error.message,
  );
  return error;
}
