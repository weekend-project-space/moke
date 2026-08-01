import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import { CronExpressionParser } from 'cron-parser';
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  ScheduledTaskStatus,
  UpdateScheduledTaskRequest,
} from '@moke/protocol';
import type { SessionApplicationService } from './session-application-service.js';
import type { ScheduledTaskStore } from '../storage/scheduled-task-store.js';

const TICK_INTERVAL_MS = 30_000;

export class ScheduledTaskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class ScheduledTaskService {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly sessions: SessionApplicationService,
  ) {}

  start(now = new Date()) {
    for (const task of this.store.list()) {
      task.next_run_at = task.status === 'enabled'
        ? nextCronOccurrence(task.cron, task.timezone, now)
        : undefined;
      task.updated_at = now.toISOString();
      this.store.save(task);
    }
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(status?: ScheduledTaskStatus) {
    return this.store.list()
      .filter((task) => !status || task.status === status)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  get(id: string) {
    return this.store.get(id);
  }

  create(input: CreateScheduledTaskRequest, now = new Date()) {
    validateWorkspace(input.workspace_root);
    const createdAt = now.toISOString();
    const status = input.status || 'enabled';
    const task: ScheduledTask = {
      id: `task_${randomUUID().slice(0, 8)}`,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      cron: normalizeCron(input.cron),
      timezone: input.timezone.trim(),
      status,
      workspace_root: resolve(input.workspace_root),
      approval_mode: input.approval_mode,
      ...(status === 'enabled'
        ? { next_run_at: nextCronOccurrence(input.cron, input.timezone, now) }
        : {}),
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.store.save(task);
    return task;
  }

  update(id: string, input: UpdateScheduledTaskRequest, now = new Date()) {
    const task = this.store.get(id);
    if (!task) return undefined;
    if (input.workspace_root !== undefined) validateWorkspace(input.workspace_root);

    const next: ScheduledTask = {
      ...task,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
      ...(input.cron !== undefined ? { cron: normalizeCron(input.cron) } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone.trim() } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.workspace_root !== undefined ? { workspace_root: resolve(input.workspace_root) } : {}),
      ...(input.approval_mode !== undefined ? { approval_mode: input.approval_mode } : {}),
      updated_at: now.toISOString(),
    };
    next.next_run_at = next.status === 'enabled'
      ? nextCronOccurrence(next.cron, next.timezone, now)
      : undefined;
    this.store.save(next);
    return next;
  }

  remove(id: string) {
    return this.store.remove(id);
  }

  pause(id: string) {
    return this.update(id, { status: 'paused' });
  }

  resume(id: string) {
    return this.update(id, { status: 'enabled' });
  }

  tick(now = new Date()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const task of this.store.list()) {
        if (task.status !== 'enabled' || !task.next_run_at || task.next_run_at > now.toISOString()) continue;
        this.execute(task, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private execute(task: ScheduledTask, now: Date) {
    task.last_run_at = now.toISOString();
    task.next_run_at = nextCronOccurrence(task.cron, task.timezone, now);
    task.updated_at = now.toISOString();
    this.store.save(task);

    try {
      const session = this.sessions.createSession({
        title: `Scheduled: ${task.name}`,
        metadata: { origin: 'scheduled', scheduled_task_id: task.id },
        env: {
          approval_mode: task.approval_mode,
          workspace: { root: task.workspace_root },
        },
      });
      const run = this.sessions.acceptUserMessage({
        session,
        content: task.prompt,
        options: { origin: { kind: 'scheduled', task_id: task.id } },
      });
      task.last_session_id = session.id;
      task.last_run_id = run.runId;
      task.updated_at = new Date().toISOString();
      this.store.save(task);
    } catch (error) {
      console.error(`Failed to run scheduled task ${task.id}:`, error);
    }
  }
}

export function nextCronOccurrence(cron: string, timezone: string, now = new Date()): string {
  const normalizedCron = normalizeCron(cron);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(now);
    const next = CronExpressionParser.parse(normalizedCron, {
      currentDate: now,
      tz: timezone,
    }).next().toISOString();
    if (!next) throw new Error('cron has no next occurrence');
    return next;
  } catch {
    throw new ScheduledTaskError('INVALID_SCHEDULE', 'cron or timezone is invalid');
  }
}

function normalizeCron(cron: string) {
  const normalized = cron.trim().replace(/\s+/g, ' ');
  if (normalized.split(' ').length !== 5) {
    throw new ScheduledTaskError('INVALID_SCHEDULE', 'cron must contain 5 fields');
  }
  return normalized;
}

function validateWorkspace(workspaceRoot: string) {
  if (!isAbsolute(workspaceRoot.trim())) {
    throw new ScheduledTaskError('INVALID_WORKSPACE', 'workspace_root must be an absolute path');
  }
}
