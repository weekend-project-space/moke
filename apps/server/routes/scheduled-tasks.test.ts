import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRouter } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { registerScheduledTaskRoutes } from './scheduled-tasks.js';
import { ScheduledTaskStore } from '../storage/scheduled-task-store.js';
import { ScheduledTaskService } from '../services/scheduled-task-service.js';
import type { SessionApplicationService } from '../services/session-application-service.js';

test('scheduled task routes create, filter, pause, update, resume, and delete tasks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-scheduled-routes-'));
  const store = new ScheduledTaskStore(directory);
  store.initialize();
  const service = new ScheduledTaskService(store, {} as SessionApplicationService);
  const router = createRouter<RoutesContext>();
  registerScheduledTaskRoutes(router);
  const server = http.createServer(router.handler({ scheduledTaskService: service } as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const createdResponse = await fetch(`${baseUrl}/api/scheduled-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Review',
        prompt: 'Review this workspace',
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        workspace_root: directory,
        approval_mode: 'workspace-write',
      }),
    });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json() as { task: { id: string } };

    const enabled = await fetch(`${baseUrl}/api/scheduled-tasks?status=enabled`).then((response) => response.json()) as { tasks: unknown[] };
    assert.equal(enabled.tasks.length, 1);

    const pausedResponse = await fetch(`${baseUrl}/api/scheduled-tasks/${created.task.id}/pause`, { method: 'POST' });
    assert.equal(pausedResponse.status, 200);
    const paused = await fetch(`${baseUrl}/api/scheduled-tasks?status=paused`).then((response) => response.json()) as { tasks: unknown[] };
    assert.equal(paused.tasks.length, 1);

    const updatedResponse = await fetch(`${baseUrl}/api/scheduled-tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated review' }),
    });
    assert.equal(updatedResponse.status, 200);

    assert.equal((await fetch(`${baseUrl}/api/scheduled-tasks/${created.task.id}/resume`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/scheduled-tasks/${created.task.id}`, { method: 'DELETE' })).status, 204);
    const all = await fetch(`${baseUrl}/api/scheduled-tasks`).then((response) => response.json()) as { tasks: unknown[] };
    assert.equal(all.tasks.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
