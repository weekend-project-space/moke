import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerResponse } from 'node:http';
import { BrowserBridge, BrowserBridgeBackend } from './browser-bridge.js';

function response(onWrite?: (value: string) => void) {
  return {
    writeHead() {},
    write(value: unknown) {
      onWrite?.(String(value));
      return true;
    },
    end() {},
  } as unknown as ServerResponse;
}

test('BrowserBridge rejects pending requests when its client disconnects', async () => {
  const bridge = new BrowserBridge();
  const client = response();
  bridge.connect(client);

  const pending = bridge.request('list_pages');
  bridge.disconnect(client);

  await assert.rejects(pending, /disconnected/);
});

test('BrowserBridge rejects old pending requests when its client is replaced', async () => {
  const bridge = new BrowserBridge();
  bridge.connect(response());

  const pending = bridge.request('list_pages');
  bridge.connect(response());

  await assert.rejects(pending, /replaced/);
  bridge.close();
});

test('BrowserBridgeBackend retries snapshots after a client replacement', async () => {
  const bridge = new BrowserBridge();
  bridge.connect(response());
  const backend = new BrowserBridgeBackend(bridge);
  const pending = backend.takeSnapshot({}, 'E:\\work\\project');

  bridge.connect(response((value) => {
    const line = value.split('\n').find((entry) => entry.startsWith('data: '));
    if (!line) return;
    const request = JSON.parse(line.slice('data: '.length)) as { id: string };
    bridge.respond(request.id, { ok: true, result: { pages: [], activePageId: 1 } });
  }));

  assert.deepEqual(await pending, { pages: [], activePageId: 1 });
  bridge.close();
});
