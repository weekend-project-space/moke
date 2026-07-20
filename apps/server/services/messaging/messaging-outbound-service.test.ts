import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { MessagingConnectionManager } from './connection-manager.js';
import { DefaultMessagingOutboundService } from './messaging-outbound-service.js';
import { JsonMessagingStore } from '../../storage/messaging-store.js';

test('outbound service sends workspace media once for an idempotency key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-outbound-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const connection = store.createConnection({
      name: 'Weixin',
      ilinkBotId: 'bot@im.bot',
      apiBaseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'token',
    });
    const binding = store.createBinding({ connectionId: connection.id, conversationId: 'user@im.wechat', sessionId: 'sess_1' });
    writeFileSync(join(directory, 'report.txt'), 'report');
    const sent: string[] = [];
    const connections = {
      async sendTextForBinding(_connectionId: string, _bindingId: string, text: string) { sent.push(`text:${text}`); },
      async sendMediaForBinding(_connectionId: string, _bindingId: string, media: { type: string; name: string }) { sent.push(`${media.type}:${media.name}`); },
    } as unknown as MessagingConnectionManager;
    const service = new DefaultMessagingOutboundService(store, connections, directory);
    const request = {
      binding_id: binding.id,
      idempotency_key: 'run_1:tool:call_1',
      contents: [{ type: 'text' as const, text: 'done' }, { type: 'file' as const, path: 'report.txt' }],
    };

    const first = await service.send(request);
    const second = await service.send(request);

    assert.deepEqual(sent, ['text:done', 'file:report.txt']);
    assert.equal(first.receipts.length, 2);
    assert.deepEqual(second, first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('outbound service requests approval for paths outside the workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-outbound-path-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const connection = store.createConnection({ name: 'Weixin', ilinkBotId: 'bot@im.bot', apiBaseUrl: 'https://ilinkai.weixin.qq.com', token: 'token' });
    const binding = store.createBinding({ connectionId: connection.id, conversationId: 'user@im.wechat', sessionId: 'sess_1' });
    const service = new DefaultMessagingOutboundService(store, {} as MessagingConnectionManager, directory);

    await assert.rejects(
      () => service.send({ binding_id: binding.id, idempotency_key: 'run_1:tool:call_2', contents: [{ type: 'file', path: '../outside.txt' }] }),
      /requires approval/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('outbound service accepts a file in an approved directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-outbound-workspace-'));
  const approvedDirectory = mkdtempSync(join(tmpdir(), 'moke-outbound-approved-'));
  try {
    const store = new JsonMessagingStore(join(directory, 'store'));
    store.initialize();
    const connection = store.createConnection({ name: 'Weixin', ilinkBotId: 'bot@im.bot', apiBaseUrl: 'https://ilinkai.weixin.qq.com', token: 'token' });
    const binding = store.createBinding({ connectionId: connection.id, conversationId: 'user@im.wechat', sessionId: 'sess_1' });
    const filePath = join(approvedDirectory, 'report.txt');
    writeFileSync(filePath, 'report');
    const sent: string[] = [];
    const connections = {
      async sendMediaForBinding(_connectionId: string, _bindingId: string, media: { name: string }) { sent.push(media.name); },
    } as unknown as MessagingConnectionManager;
    const service = new DefaultMessagingOutboundService(store, connections, directory, () => [directory, approvedDirectory]);

    await service.send({
      binding_id: binding.id,
      idempotency_key: 'run_1:tool:call_3',
      contents: [{ type: 'file', path: filePath }],
    });

    assert.deepEqual(sent, ['report.txt']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(approvedDirectory, { recursive: true, force: true });
  }
});
