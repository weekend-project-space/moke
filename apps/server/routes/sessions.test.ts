import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { Session } from '@moke/protocol';
import { createRouter } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { registerSessionRoutes } from './sessions.js';

test('session detail omits internal context messages from the public API', async () => {
  const session: Session = {
    id: 'sess_1',
    title: 'Test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    messages: [
      {
        id: 'msg_user',
        role: 'user',
        content: 'Use openwalk',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'msg_skill',
        role: 'user',
        content: '<active_skill id="openwalk-usage">instructions</active_skill>',
        created_at: '2026-01-01T00:00:01.000Z',
        visibility: 'internal',
      },
    ],
    metadata: {},
  };
  const router = createRouter<RoutesContext>();
  registerSessionRoutes(router);
  const server = http.createServer(router.handler({
    sessionStore: { get: () => session },
  } as unknown as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { messages: Session['messages'] };
    assert.deepEqual(payload.messages, [session.messages[0]]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
