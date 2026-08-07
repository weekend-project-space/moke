import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FeishuLoginService,
  OfficialFeishuRegistration,
  renderFeishuQrCode,
  type FeishuRegistration,
} from './feishu-login-service.js';

test('treats Feishu HTTP 400 authorization_pending as a normal poll state', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ error: 'authorization_pending' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
  const registration = new OfficialFeishuRegistration(fetchImpl);

  assert.deepEqual(
    await registration.poll('feishu', 'device-code', new AbortController().signal),
    { status: 'pending' },
  );
});

test('renders Feishu QR content as a local PNG data URL', async () => {
  const image = await renderFeishuQrCode('https://accounts.feishu.cn/device?code=abc');
  assert.match(image, /^data:image\/png;base64,/);
});

test('rejects an empty Feishu QR payload', () => {
  assert.throws(() => renderFeishuQrCode('  '), /QR code content is empty/);
});

test('persists confirmed app credentials without exposing them in the login snapshot', async () => {
  let now = 1_000;
  const created: unknown[] = [];
  const registration: FeishuRegistration = {
    async start() {
      return {
        deviceCode: 'device-secret',
        verificationUrl: 'https://accounts.feishu.cn/device?code=abc',
        pollIntervalMs: 1_000,
        expiresInMs: 60_000,
      };
    },
    async poll() {
      return { status: 'confirmed', credential: { appId: 'cli_test', appSecret: 'app-secret' } };
    },
  };
  const service = new FeishuLoginService({
    async createConnection(input) {
      created.push(input);
      return connection('fsconn_test');
    },
    async removeConnection() {},
  }, registration, () => now);

  const started = await service.start({ domain: 'feishu' });
  assert.equal(started.status, 'waiting_scan');
  assert.match(started.qr_image || '', /^data:image\/png;base64,/);
  now += 1_000;
  const confirmed = await service.get(started.id);

  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.connection?.id, 'fsconn_test');
  assert.deepEqual(created, [{
    platform: 'feishu',
    credentials: { appId: 'cli_test', appSecret: 'app-secret', domain: 'feishu' },
  }]);
  assert.equal(JSON.stringify(confirmed).includes('app-secret'), false);
  assert.equal(JSON.stringify(confirmed).includes('device-secret'), false);
});

test('cancellation during connection creation removes the late connection', async () => {
  let now = 1_000;
  let releaseConnection!: () => void;
  const connectionStarted = new Promise<void>((resolve) => { releaseConnection = resolve; });
  let finishConnection!: () => void;
  const connectionFinished = new Promise<void>((resolve) => { finishConnection = resolve; });
  const removed: string[] = [];
  const registration: FeishuRegistration = {
    async start() {
      return {
        deviceCode: 'device-secret',
        verificationUrl: 'https://accounts.feishu.cn/device?code=abc',
        pollIntervalMs: 1_000,
        expiresInMs: 60_000,
      };
    },
    async poll() {
      return { status: 'confirmed', credential: { appId: 'cli_test', appSecret: 'app-secret' } };
    },
  };
  const service = new FeishuLoginService({
    async createConnection() {
      releaseConnection();
      await connectionFinished;
      return connection('fsconn_late');
    },
    async removeConnection(id) { removed.push(id); },
  }, registration, () => now);

  const started = await service.start({ domain: 'feishu' });
  now += 1_000;
  const polling = service.get(started.id);
  await connectionStarted;
  service.cancel(started.id);
  finishConnection();

  assert.equal((await polling).status, 'cancelled');
  assert.deepEqual(removed, ['fsconn_late']);
});

function connection(id: string) {
  return {
    id,
    platform: 'feishu' as const,
    name: 'Feishu',
    enabled: true,
    app_id: 'cli_test',
    domain: 'feishu' as const,
    state: 'connected' as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
