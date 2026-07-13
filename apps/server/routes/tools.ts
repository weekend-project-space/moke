import type { RoutesContext } from './context.js';
import type { Router } from '../http/router.js';

export function registerToolRoutes(router: Router<RoutesContext>) {
  router.get('/api/tools', ({ context, json }) => {
    return json(200, {
      tools: context.toolRegistry.list().map(({ schema, ...tool }) => tool),
    });
  });
}
