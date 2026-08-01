import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Session } from '@moke/protocol';
import { ScheduledTaskStore } from '../storage/scheduled-task-store.js';
import type { SessionApplicationService } from './session-application-service.js';
import { nextCronOccurrence, ScheduledTaskService } from './scheduled-task-service.js';

test('calculates the next cron occurrence in the selected timezone', () => {
  assert.equal(
    nextCronOccurrence('0 9 * * *', 'Asia/Shanghai', new Date('2026-07-29T00:30:00.000Z')),
    '2026-07-29T01:00:00.000Z',
  );
});

test('persists tasks and starts an agent session when a task is due', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-scheduled-tasks-'));
  try {
    const store = new ScheduledTaskStore(directory);
    store.initialize();
    const calls: Array<{ title: string; prompt: string }> = [];
    const session: Session = {
      id: 'sess_scheduled',
      title: 'Scheduled',
      created_at: '2026-07-29T00:00:00.000Z',
      updated_at: '2026-07-29T00:00:00.000Z',
      messages: [],
      metadata: {},
    };
    const sessions = {
      createSession(input: { title: string }) {
        calls.push({ title: input.title, prompt: '' });
        return session;
      },
      acceptUserMessage(input: { content: string }) {
        calls[0]!.prompt = input.content;
        return { messageId: 'msg_1', runId: 'run_scheduled' };
      },
    } as unknown as SessionApplicationService;
    const service = new ScheduledTaskService(store, sessions);
    const task = service.create({
      name: 'Daily review',
      prompt: 'Review the workspace',
      cron: '1 0 * * *',
      timezone: 'UTC',
      workspace_root: directory,
      approval_mode: 'ai_review',
    }, new Date('2026-07-29T00:00:00.000Z'));

    service.tick(new Date('2026-07-29T00:01:00.000Z'));

    assert.deepEqual(calls, [{ title: 'Scheduled: Daily review', prompt: 'Review the workspace' }]);
    assert.equal(task.last_session_id, 'sess_scheduled');
    assert.equal(task.last_run_id, 'run_scheduled');

    const reloaded = new ScheduledTaskStore(directory);
    reloaded.initialize();
    assert.equal(reloaded.get(task.id)?.last_run_id, 'run_scheduled');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('paused tasks are not executed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-scheduled-paused-'));
  try {
    const store = new ScheduledTaskStore(directory);
    store.initialize();
    let called = false;
    const sessions = {
      createSession() {
        called = true;
        throw new Error('should not run');
      },
    } as unknown as SessionApplicationService;
    const service = new ScheduledTaskService(store, sessions);
    service.create({
      name: 'Paused task',
      prompt: 'Do not run',
      cron: '* * * * *',
      timezone: 'UTC',
      workspace_root: directory,
      approval_mode: 'manual',
      status: 'paused',
    });

    service.tick(new Date(Date.now() + 120_000));
    assert.equal(called, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
