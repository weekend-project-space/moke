import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DingTalkLoginService,
  OfficialDingTalkRegistration,
  renderDingTalkQrCode,
  type DingTalkRegistration,
} from './dingtalk-login-service.js';

test('uses the DingTalk application registration endpoints and Moke source', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const responses = [
    { errcode: 0, nonce: 'nonce-value' },
    {
      device_code: 'device-code',
      pc_verification_uri_complete: 'https://login.dingtalk.com/oauth?code=abc',
      interval: 5,
      expires_in: 7200,
    },
    { status: 'WAITING' },
  ];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) });
    return Response.json(responses.shift());
  }) as typeof fetch;
  const registration = new OfficialDingTalkRegistration(fetchImpl);

  const started = await registration.start(new AbortController().signal);
  assert.equal(started.deviceCode, 'device-code');
  assert.equal(started.pollIntervalMs, 5_000);
  assert.equal(started.expiresInMs, 7_200_000);
  assert.deepEqual(await registration.poll('device-code', new AbortController().signal), { status: 'pending' });
  assert.deepEqual(requests, [
    { url: 'https://oapi.dingtalk.com/app/registration/init', body: { source: 'MOKE' } },
    { url: 'https://oapi.dingtalk.com/app/registration/begin', body: { nonce: 'nonce-value' } },
    { url: 'https://oapi.dingtalk.com/app/registration/poll', body: { device_code: 'device-code' } },
  ]);
});

test('renders DingTalk QR content as a local PNG data URL', async () => {
  const image = await renderDingTalkQrCode('https://login.dingtalk.com/oauth?code=abc');
  assert.match(image, /^data:image\/png;base64,/);
});

test('creates a DingTalk connection without exposing registration secrets', async () => {
  let now = 1_000;
  const created: unknown[] = [];
  const registration: DingTalkRegistration = {
    async start() {
      return {
        deviceCode: 'device-secret',
        verificationUrl: 'https://login.dingtalk.com/oauth?code=abc',
        pollIntervalMs: 1_000,
        expiresInMs: 60_000,
      };
    },
    async poll() {
      return {
        status: 'confirmed',
        credential: { clientId: 'ding-client', clientSecret: 'ding-secret' },
      };
    },
  };
  const service = new DingTalkLoginService({
    async createConnection(input) {
      created.push(input);
      return connection('dtconn_test');
    },
    async removeConnection() {},
  }, registration, () => now);

  const started = await service.start();
  now += 1_000;
  const confirmed = await service.get(started.id);

  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(created, [{
    platform: 'dingtalk',
    credentials: { clientId: 'ding-client', clientSecret: 'ding-secret' },
  }]);
  assert.equal(JSON.stringify(confirmed).includes('ding-secret'), false);
  assert.equal(JSON.stringify(confirmed).includes('device-secret'), false);
});

function connection(id: string) {
  return {
    id,
    platform: 'dingtalk' as const,
    name: 'DingTalk',
    enabled: true,
    client_id: 'ding-client',
    state: 'connected' as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
