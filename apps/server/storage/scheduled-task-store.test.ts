import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ScheduledTaskStore } from './scheduled-task-store.js';

test('initialize discards scheduled tasks with removed permission modes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'moke-scheduled-task-store-'));
  try {
    writeFileSync(path.join(directory, 'scheduled-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'task_old',
          name: 'Old task',
          prompt: 'old',
          cron: '* * * * *',
          timezone: 'UTC',
          status: 'paused',
          workspace_root: directory,
          approval_mode: 'auto_approve',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'task_valid',
          name: 'Valid task',
          prompt: 'valid',
          cron: '* * * * *',
          timezone: 'UTC',
          status: 'paused',
          workspace_root: directory,
          approval_mode: 'workspace-write',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));

    const store = new ScheduledTaskStore(directory);
    store.initialize();

    assert.deepEqual(store.list().map((task) => task.id), ['task_valid']);
    const persisted = JSON.parse(readFileSync(path.join(directory, 'scheduled-tasks.json'), 'utf8')) as { tasks: Array<{ id: string }> };
    assert.deepEqual(persisted.tasks.map((task) => task.id), ['task_valid']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('initialize rejects a malformed task even when it uses a removed permission mode', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'moke-scheduled-task-store-'));
  try {
    writeFileSync(path.join(directory, 'scheduled-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id: 'task_broken',
        approval_mode: 'manual',
      }],
    }));

    const store = new ScheduledTaskStore(directory);
    assert.throws(() => store.initialize(), /Invalid scheduled task in store/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
