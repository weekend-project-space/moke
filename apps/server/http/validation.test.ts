import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { createRouter } from './router.js';
import {
  idParamsSchema,
  listSessionsQuerySchema,
  messagingConnectionCreateSchema,
  messagingConnectionUpdateSchema,
  runRespondSchema,
} from '../routes/schemas.js';
import { parseBody, parseInput, parseParams, parseQuery, RequestValidationError } from './validation.js';

test('parseInput exposes stable validation issues', () => {
  assert.throws(
    () => parseInput(idParamsSchema, { id: '../escape' }),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.issues[0]?.path[0], 'id');
      return true;
    },
  );
});

test('parseParams and parseQuery return typed normalized values', () => {
  assert.deepEqual(parseParams({ id: 'sess_123' }, idParamsSchema), { id: 'sess_123' });
  assert.deepEqual(
    parseQuery(new URLSearchParams('include_archived=true'), listSessionsQuerySchema),
    { include_archived: 'true' },
  );
});

test('run response schema rejects invalid variants and accepts typed variants', () => {
  assert.equal(runRespondSchema.safeParse({ type: 'choose', request_id: 'ask_1' }).success, false);
  assert.equal(runRespondSchema.safeParse({ type: 'choose', request_id: 'ask_1', option_id: 'yes' }).success, true);
  assert.equal(runRespondSchema.safeParse({ type: 'choose', request_id: 'ask_1', custom_text: 'Another answer' }).success, true);
  assert.equal(runRespondSchema.safeParse({
    type: 'choose', request_id: 'ask_1', option_id: 'yes', custom_text: 'Another answer',
  }).success, false);
  assert.equal(runRespondSchema.safeParse({ type: 'approve', request_id: 'approval_1', decision: 'approved' }).success, true);
  assert.equal(runRespondSchema.safeParse({ type: 'cancel', reason: 'User cancelled' }).success, true);
});

test('messaging connection schema accepts Feishu credentials and defaults the domain', () => {
  assert.deepEqual(messagingConnectionCreateSchema.parse({
    platform: 'feishu',
    credentials: { appId: 'cli_app_id', appSecret: 'app-secret' },
  }), {
    platform: 'feishu',
    credentials: { appId: 'cli_app_id', appSecret: 'app-secret', domain: 'feishu' },
  });
  assert.equal(messagingConnectionCreateSchema.safeParse({
    platform: 'feishu',
    credentials: { appId: '', appSecret: 'app-secret' },
  }).success, false);
});

test('messaging connection update accepts DingTalk policy fields', () => {
  assert.deepEqual(parseInput(messagingConnectionUpdateSchema, {
    allowedUserIds: ['staff_1'],
    cardTemplateId: 'template.schema',
  }), {
    allowedUserIds: ['staff_1'],
    cardTemplateId: 'template.schema',
  });
  assert.throws(() => parseInput(messagingConnectionUpdateSchema, {}), RequestValidationError);
});

test('router returns one validation error shape', async () => {
  const router = createRouter<{}>();
  router.post('/api/example', async ({ body, json }) => {
    const input = await parseBody(body, z.object({ required: z.string() }).strict());
    return json(200, input);
  });

  const request = Readable.from(['{}']) as IncomingMessage;
  request.method = 'POST';
  request.url = '/api/example';
  request.headers = { host: 'localhost' };
  const responseBody: { status?: number; body?: unknown } = {};
  const responseStub = {
    writableEnded: false,
    writeHead(status: number) {
      responseBody.status = status;
    },
    end(body?: string) {
      responseBody.body = body ? JSON.parse(body) : undefined;
      responseStub.writableEnded = true;
    },
  };
  const response = responseStub as unknown as ServerResponse;

  await router.handler({})(request, response);

  assert.equal(responseBody.status, 400);
  assert.deepEqual(responseBody.body, {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ path: ['required'], message: 'Invalid input: expected string, received undefined' }],
    },
  });
});

test('router dispatches DELETE requests and sends an empty 204 response', async () => {
  const router = createRouter<{}>();
  router.delete('/api/example/:id', ({ json, params }) => {
    assert.equal(params.id, 'item_1');
    return json(204, undefined);
  });

  const request = Readable.from([]) as IncomingMessage;
  request.method = 'DELETE';
  request.url = '/api/example/item_1';
  request.headers = { host: 'localhost' };
  const responseBody: { status?: number; body?: string } = {};
  const responseStub = {
    writableEnded: false,
    writeHead(status: number) {
      responseBody.status = status;
    },
    end(body?: string) {
      responseBody.body = body;
      responseStub.writableEnded = true;
    },
  };

  await router.handler({})(request, responseStub as unknown as ServerResponse);

  assert.equal(responseBody.status, 204);
  assert.equal(responseBody.body, undefined);
});

test('router enforces the API token and allowed origins', async () => {
  const router = createRouter<{}>({
    apiToken: 'test-token',
    allowedOrigins: ['http://tauri.localhost'],
  });
  router.get('/api/example', ({ json }) => json(200, { ok: true }));
  const server = http.createServer(router.handler({}));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  try {
    const missing = await fetch(`http://127.0.0.1:${address.port}/api/example`);
    assert.equal(missing.status, 401);

    const wrongOrigin = await fetch(`http://127.0.0.1:${address.port}/api/example`, {
      headers: { Authorization: 'Bearer test-token', Origin: 'https://evil.example' },
    });
    assert.equal(wrongOrigin.status, 403);

    const allowed = await fetch(`http://127.0.0.1:${address.port}/api/example`, {
      headers: { Authorization: 'Bearer test-token', Origin: 'http://tauri.localhost' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
