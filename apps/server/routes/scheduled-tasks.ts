import { HttpError, type Router } from '../http/router.js';
import { parseBody, parseParams, parseQuery } from '../http/validation.js';
import type { RoutesContext } from './context.js';
import {
  createScheduledTaskSchema,
  idParamsSchema,
  listScheduledTasksQuerySchema,
  updateScheduledTaskSchema,
} from './schemas.js';
import { ScheduledTaskError } from '../services/scheduled-task-service.js';

export function registerScheduledTaskRoutes(router: Router<RoutesContext>) {
  router.get('/api/scheduled-tasks', ({ context, json, query }) => {
    const { status } = parseQuery(query, listScheduledTasksQuerySchema);
    return json(200, { tasks: context.scheduledTaskService.list(status) });
  });

  router.post('/api/scheduled-tasks', async ({ body, context, json }) => {
    const input = await parseBody(body, createScheduledTaskSchema);
    return json(200, { task: withScheduledTaskError(() => context.scheduledTaskService.create(input)) });
  });

  router.patch('/api/scheduled-tasks/:id', async ({ body, context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const input = await parseBody(body, updateScheduledTaskSchema);
    const task = withScheduledTaskError(() => context.scheduledTaskService.update(id, input));
    if (!task) throw new HttpError(404, 'SCHEDULED_TASK_NOT_FOUND', 'Scheduled task not found');
    return json(200, { task });
  });

  router.delete('/api/scheduled-tasks/:id', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    if (!context.scheduledTaskService.remove(id)) {
      throw new HttpError(404, 'SCHEDULED_TASK_NOT_FOUND', 'Scheduled task not found');
    }
    return json(204, {});
  });

  router.post('/api/scheduled-tasks/:id/pause', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const task = context.scheduledTaskService.pause(id);
    if (!task) throw new HttpError(404, 'SCHEDULED_TASK_NOT_FOUND', 'Scheduled task not found');
    return json(200, { task });
  });

  router.post('/api/scheduled-tasks/:id/resume', ({ context, json, params }) => {
    const { id } = parseParams(params, idParamsSchema);
    const task = withScheduledTaskError(() => context.scheduledTaskService.resume(id));
    if (!task) throw new HttpError(404, 'SCHEDULED_TASK_NOT_FOUND', 'Scheduled task not found');
    return json(200, { task });
  });
}

function withScheduledTaskError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ScheduledTaskError) throw new HttpError(400, error.code, error.message);
    throw error;
  }
}
