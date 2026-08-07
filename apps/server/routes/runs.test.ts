import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { RunManager, ToolRegistry, type Agent } from '@moke/agent-runtime';
import type { RunLifecycleEvent, Session } from '@moke/protocol';
import { createRouter } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { registerRunRoutes } from './runs.js';

test('run lifecycle route sends current and subsequent statuses across sessions', async () => {
  const runs = new Map();
  let finishAgent!: () => void;
  const waitForFinish = new Promise<void>((resolve) => { finishAgent = resolve; });
  const agent: Agent = {
    async run() {
      await waitForFinish;
      return {
        toolCalls: 0,
        message: {
          id: 'msg_done',
          role: 'assistant',
          content: 'done',
          created_at: new Date().toISOString(),
        },
      };
    },
  };
  const runManager = new RunManager({
    runs,
    agent,
    toolRegistry: new ToolRegistry(),
    workspace: process.cwd(),
  });
  const session: Session = {
    id: 'sess_1',
    title: 'Test',
    visibility: 'visible',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: [],
    metadata: {},
  };
  const run = runManager.createRun(session, { content: 'start' });
  const router = createRouter<RoutesContext>();
  registerRunRoutes(router);
  const server = http.createServer(router.handler({ runs, runManager } as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/runs/lifecycle`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const nextEvent = createEventReader(response.body!);

    assert.deepEqual(await nextEvent(), {
      type: 'running',
      sessionId: session.id,
      runId: run.id,
    });

    runManager.cancel(run.id);

    assert.deepEqual(await nextEvent(), {
      type: 'cancelled',
      sessionId: session.id,
      runId: run.id,
    });
  } finally {
    controller.abort();
    finishAgent();
    await runManager.shutdown();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function createEventReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return async function nextEvent(): Promise<RunLifecycleEvent> {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
        if (data) return JSON.parse(data) as RunLifecycleEvent;
      }

      const { done, value } = await reader.read();
      if (done) throw new Error('Run lifecycle stream ended before the next event');
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    }
  };
}
