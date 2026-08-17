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
    const unsupportedPermissionTasks = invalidTasks.filter(isUnsupportedPermissionTask);
    if (unsupportedPermissionTasks.length !== invalidTasks.length) {
      throw new Error('Invalid scheduled task in store');
    }
    for (const task of stored.tasks) {
      if (isScheduledTask(task)) this.tasks.set(task.id, task);
    }
    if (unsupportedPermissionTasks.length > 0) {
      console.warn(`Discarding ${unsupportedPermissionTasks.length} scheduled task(s) with an unsupported permission mode`);
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

function isUnsupportedPermissionTask(value: unknown) {
  if (!hasScheduledTaskFields(value)) return false;
  const mode = value.approval_mode;
  return mode === 'manual' || mode === 'ai_review' || mode === 'auto_approve';
}

function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!hasScheduledTaskFields(value)) return false;
  return value.approval_mode === 'read-only'
    || value.approval_mode === 'workspace-write'
    || value.approval_mode === 'danger-full-access';
}

function hasScheduledTaskFields(value: unknown): value is Omit<ScheduledTask, 'approval_mode'> & { approval_mode: unknown } {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<ScheduledTask>;
  return typeof task.id === 'string'
    && typeof task.name === 'string'
    && typeof task.prompt === 'string'
    && typeof task.cron === 'string'
    && typeof task.timezone === 'string'
    && (task.status === 'enabled' || task.status === 'paused')
    && typeof task.workspace_root === 'string'
    && typeof task.created_at === 'string'
    && typeof task.updated_at === 'string';
}
