import type { RoutesContext } from './context.js';
import { now } from '../domain/sessions.js';
import type { Router } from '../http/router.js';

export function registerHealthRoutes(router: Router<RoutesContext>) {
  router.get('/api/health', ({ json }) => {
    return json(200, {
      status: 'ok',
      service: 'moke-agent-server',
      ts: now(),
    });
  });
}
