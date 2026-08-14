import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScheduledTask } from '@moke/protocol';

type StoredTasks = {
  version: 1;
  tasks: ScheduledTask[];
};

export class ScheduledTaskStore {
  private readonly filePath: string;
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(private readonly storePath: string) {
    this.filePath = join(storePath, 'scheduled-tasks.json');
  }

  initialize() {
    mkdirSync(this.storePath, { recursive: true });
    if (!existsSync(this.filePath)) return;

    const stored = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredTasks>;
    if (stored.version !== 1 || !Array.isArray(stored.tasks)) {
      throw new Error('Invalid scheduled task store');
    }

    this.tasks.clear();
    const invalidTasks = stored.tasks.filter((task) => !isScheduledTask(task));
    for (const task of stored.tasks) {
      if (isScheduledTask(task)) this.tasks.set(task.id, task);
    }
    if (invalidTasks.length > 0) {
      console.warn(`Discarding ${invalidTasks.length} scheduled task(s) with an unsupported permission mode`);
      this.flush();
    }
  }

  list() {
    return [...this.tasks.values()];
  }

  get(id: string) {
    return this.tasks.get(id);
  }

  save(task: ScheduledTask) {
    this.tasks.set(task.id, task);
    this.flush();
  }

  remove(id: string) {
    const removed = this.tasks.delete(id);
    if (removed) this.flush();
    return removed;
  }

  flush() {
    mkdirSync(this.storePath, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const payload: StoredTasks = { version: 1, tasks: this.list() };
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<ScheduledTask>;
  return typeof task.id === 'string'
    && typeof task.name === 'string'
    && typeof task.prompt === 'string'
    && typeof task.cron === 'string'
    && typeof task.timezone === 'string'
    && (task.status === 'enabled' || task.status === 'paused')
    && typeof task.workspace_root === 'string'
    && (task.approval_mode === 'read-only' || task.approval_mode === 'workspace-write' || task.approval_mode === 'danger-full-access')
    && typeof task.created_at === 'string'
    && typeof task.updated_at === 'string';
}
