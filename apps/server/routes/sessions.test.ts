import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { Session } from '@moke/protocol';
import { createRouter } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { registerSessionRoutes } from './sessions.js';
import { sendMessageSchema } from './schemas.js';

test('send API accepts run timeouts up to 72 hours', () => {
  const request = {
    message: { role: 'user', content: 'long task' },
    options: { timeout_ms: 72 * 60 * 60 * 1_000 },
  };

  assert.equal(sendMessageSchema.safeParse(request).success, true);
  assert.equal(sendMessageSchema.safeParse({
    ...request,
    options: { timeout_ms: 72 * 60 * 60 * 1_000 + 1 },
  }).success, false);
});

test('send API validates the optional session model environment', () => {
  assert.equal(sendMessageSchema.safeParse({
    message: { content: 'hello' },
    env: { model: { provider_id: 'provider_openai', name: 'gpt-5' } },
  }).success, true);
  assert.equal(sendMessageSchema.safeParse({
    message: { content: 'hello' },
    env: { model: { provider_id: 'bad.id' } },
  }).success, false);
});

test('session detail omits internal context messages from the public API', async () => {
  const session: Session = {
    id: 'sess_1',
    title: 'Test',
    visibility: 'visible',
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

test('session creation persists visibility and resolves its model environment', async () => {
  let saved: Session | undefined;
  const router = createRouter<RoutesContext>();
  registerSessionRoutes(router);
  const server = http.createServer(router.handler({
    sessionStore: { save: (session: Session) => { saved = session; } },
    runManager: {},
    defaultWorkspaceRoot: 'E:\\work\\test\\moke',
    settingsService: {
      resolveModelSelection: (selection: { provider_id: string; name?: string }) => ({
        provider_id: selection.provider_id,
        name: selection.name || 'default-model',
      }),
    },
  } as unknown as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        visibility: 'hidden',
        env: { model: { provider_id: 'provider_openai' } },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(saved?.visibility, 'hidden');
    assert.deepEqual(saved?.env?.model, { provider_id: 'provider_openai', name: 'default-model' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('send API applies and clears session model environment atomically', async () => {
  const session: Session = {
    id: 'sess_send_env',
    title: 'Test',
    visibility: 'visible',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    messages: [],
    metadata: {},
    env: {
      approval_mode: 'read-only',
      system: { platform: 'windows', arch: 'x64', shell: 'pwsh' },
      workspace: { root: 'E:\\work\\test\\moke' },
    },
  };
  const router = createRouter<RoutesContext>();
  registerSessionRoutes(router);
  const server = http.createServer(router.handler({
    sessionStore: { get: () => session, save: () => undefined },
    attachmentStore: { saveImages: () => [] },
    runManager: {
      getActiveRunForSession: () => undefined,
      createRun: () => ({ id: 'run_send_env' }),
    },
    defaultWorkspaceRoot: 'E:\\work\\test\\moke',
    settingsService: {
      resolveModelSelection: (selection: { provider_id: string; name?: string }) => ({
        provider_id: selection.provider_id,
        name: selection.name || 'default-model',
      }),
    },
  } as unknown as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const send = (content: string, env: unknown) => fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { role: 'user', content }, env }),
    });

    assert.equal((await send('use selected model', {
      model: { provider_id: 'provider_openai' },
      reasoningEffort: 'high',
    })).status, 200);
    assert.deepEqual(session.env?.model, { provider_id: 'provider_openai', name: 'default-model' });
    assert.equal(session.env?.reasoningEffort, 'high');

    assert.equal((await send('clear selected model', {
      model: null,
      reasoningEffort: null,
    })).status, 200);
    assert.equal(session.env?.model, undefined);
    assert.equal(session.env?.reasoningEffort, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('session list hides hidden sessions unless requested', async () => {
  const sessions = [
    { id: 'sess_visible', title: 'Visible', visibility: 'visible', archived: false },
    { id: 'sess_hidden', title: 'Hidden', visibility: 'hidden', archived: false },
  ];
  const router = createRouter<RoutesContext>();
  registerSessionRoutes(router);
  const server = http.createServer(router.handler({
    sessionStore: { list: () => sessions },
  } as unknown as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const normal = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json() as { sessions: typeof sessions };
    const all = await (await fetch(`http://127.0.0.1:${port}/api/sessions?include_hidden=true`)).json() as { sessions: typeof sessions };
    assert.deepEqual(normal.sessions.map((session) => session.id), ['sess_visible']);
    assert.deepEqual(all.sessions.map((session) => session.id), ['sess_visible', 'sess_hidden']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('session environment API updates approval mode without changing workspace', async () => {
  const session: Session = {
    id: 'sess_env', title: 'Test', visibility: 'visible', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', messages: [], metadata: {},
    env: { approval_mode: 'read-only', system: { platform: 'windows', arch: 'x64', shell: 'pwsh' }, workspace: { root: 'E:\\work\\test\\moke' } },
  };
  const router = createRouter<RoutesContext>();
  registerSessionRoutes(router);
  const server = http.createServer(router.handler({
    sessionStore: { get: () => session, save: () => undefined },
    defaultWorkspaceRoot: 'E:\\work\\test\\moke',
  } as unknown as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/env`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        approval_mode: 'danger-full-access',
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(session.env?.approval_mode, 'danger-full-access');
    assert.equal(session.env?.workspace.root, 'E:\\work\\test\\moke');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('session environment and send APIs reject workspace changes', async () => {
  const session: Session = {
    id: 'sess_env', title: 'Test', visibility: 'visible', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', messages: [], metadata: {},
    env: { approval_mode: 'read-only', system: { platform: 'windows', arch: 'x64', shell: 'pwsh' }, workspace: { root: 'E:\\work\\test\\moke' } },
  };
  const router = createRouter<RoutesContext>();
  registerSessionRoutes(router);
  const server = http.createServer(router.handler({
    sessionStore: { get: () => session, save: () => undefined },
    defaultWorkspaceRoot: 'E:\\work\\test\\moke',
  } as unknown as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const requests = [
      fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/env`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: { root: 'E:\\work\\project-a' } }),
      }),
      fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { role: 'user', content: 'review this project' },
          env: { workspace: { root: 'E:\\work\\project-a' } },
        }),
      }),
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) {
      assert.equal(response.status, 400);
      const payload = await response.json() as { error: { code: string } };
      assert.equal(payload.error.code, 'IMMUTABLE_SESSION_WORKSPACE');
    }
    assert.equal(session.env?.workspace.root, 'E:\\work\\test\\moke');
    assert.deepEqual(session.messages, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('send API rejects a second active run for the same session', async () => {
  const session: Session = {
    id: 'sess_active', title: 'Test', visibility: 'visible', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', messages: [], metadata: {},
  };
  const router = createRouter<RoutesContext>();
  registerSessionRoutes(router);
  const server = http.createServer(router.handler({
    sessionStore: { get: () => session },
    runManager: {
      getActiveRunForSession: () => ({ id: 'run_active' }),
    },
  } as unknown as RoutesContext));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { role: 'user', content: 'second message' } }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'SESSION_RUN_ACTIVE');
    assert.match(payload.error.message, /run_active/);
    assert.deepEqual(session.messages, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
