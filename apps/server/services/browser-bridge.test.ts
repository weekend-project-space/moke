import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerResponse } from 'node:http';
import { BrowserBridge } from './browser-bridge.js';

function response() {
  return {
    writeHead() {},
    write() { return true; },
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
