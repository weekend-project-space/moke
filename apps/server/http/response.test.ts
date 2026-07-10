import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import type { IncomingMessage } from 'node:http';
import { readJson, RequestBodyError } from './response.js';

function request(chunks: string[], contentLength?: number) {
  const stream = Readable.from(chunks) as IncomingMessage;
  stream.headers = contentLength === undefined ? {} : { 'content-length': String(contentLength) };
  return stream;
}

test('readJson parses an object body', async () => {
  assert.deepEqual(await readJson(request(['{"ok":true}'])), { ok: true });
});

test('readJson rejects invalid JSON as a bad request', async () => {
  await assert.rejects(
    readJson(request(['{'])),
    (error: unknown) => error instanceof RequestBodyError && error.status === 400,
  );
});

test('readJson rejects declared and streamed bodies over the limit', async () => {
  await assert.rejects(
    readJson(request([], 11), 10),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413,
  );
  await assert.rejects(
    readJson(request(['123456', '78901']), 10),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413,
  );
});
