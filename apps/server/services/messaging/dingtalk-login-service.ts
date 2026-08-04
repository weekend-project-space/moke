import type { MessagingRuntime } from './messaging-runtime.js';
import {
  RegistrationLoginService,
  renderRegistrationQrCode,
  type PublicRegistrationLogin,
  type RegistrationPoll,
  type RegistrationStart,
} from './registration-login-service.js';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TTL_MS = 2 * 60 * 60_000;

type DingTalkCredential = { clientId: string; clientSecret: string };

export type DingTalkRegistration = {
  start(signal: AbortSignal): Promise<RegistrationStart>;
  poll(deviceCode: string, signal: AbortSignal): Promise<RegistrationPoll<DingTalkCredential>>;
};

export type PublicDingTalkLogin = PublicRegistrationLogin;

type MessagingConnectionManager = Pick<MessagingRuntime, 'createConnection' | 'removeConnection'>;

export class DingTalkLoginService {
  private readonly service: RegistrationLoginService<Record<string, never>, DingTalkCredential>;

  constructor(
    messaging: MessagingConnectionManager,
    registration: DingTalkRegistration = new OfficialDingTalkRegistration(),
    now: () => number = Date.now,
  ) {
    this.service = new RegistrationLoginService({
      idPrefix: 'dtl',
      platformName: 'DingTalk',
      failureCode: 'DINGTALK_LOGIN_FAILED',
      defaultExpiresInMs: DEFAULT_LOGIN_TTL_MS,
      registration: {
        start: (_input, signal) => registration.start(signal),
        poll: (_input, deviceCode, signal) => registration.poll(deviceCode, signal),
      },
      connect: (credential) => messaging.createConnection({
        platform: 'dingtalk',
        credentials: credential,
      }),
      removeConnection: (connectionId) => messaging.removeConnection(connectionId),
      now,
    });
  }

  start() { return this.service.start({}); }
  get(loginId: string) { return this.service.get(loginId); }
  cancel(loginId: string) { return this.service.cancel(loginId); }
  close() { this.service.close(); }
}

export class OfficialDingTalkRegistration implements DingTalkRegistration {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async start(signal: AbortSignal): Promise<RegistrationStart> {
    const init = await postJson(
      this.fetchImpl,
      'https://oapi.dingtalk.com/app/registration/init',
      { source: 'MOKE' },
      signal,
    );
    if (init.errcode !== 0 || typeof init.nonce !== 'string') {
      throw new Error('DingTalk registration initialization failed');
    }
    const begin = await postJson(
      this.fetchImpl,
      'https://oapi.dingtalk.com/app/registration/begin',
      { nonce: init.nonce },
      signal,
    );
    const verificationUrl = begin.pc_verification_uri_complete ?? begin.verification_uri_complete;
    if (typeof begin.device_code !== 'string' || typeof verificationUrl !== 'string') {
      throw new Error('DingTalk returned an invalid authorization response');
    }
    const url = new URL(verificationUrl);
    if (url.protocol !== 'https:') throw new Error('DingTalk returned an invalid authorization URL');
    return {
      deviceCode: begin.device_code,
      verificationUrl: url.toString(),
      pollIntervalMs: numberValue(begin.interval, 5) * 1_000,
      expiresInMs: numberValue(begin.expires_in, DEFAULT_LOGIN_TTL_MS / 1_000) * 1_000,
    };
  }

  async poll(deviceCode: string, signal: AbortSignal): Promise<RegistrationPoll<DingTalkCredential>> {
    const result = await postJson(
      this.fetchImpl,
      'https://oapi.dingtalk.com/app/registration/poll',
      { device_code: deviceCode },
      signal,
    );
    if (result.status === 'SUCCESS') {
      if (typeof result.client_id !== 'string' || typeof result.client_secret !== 'string') {
        throw new Error('DingTalk returned incomplete app credentials');
      }
      return {
        status: 'confirmed',
        credential: { clientId: result.client_id, clientSecret: result.client_secret },
      };
    }
    if (result.status === 'WAITING') return { status: 'pending' };
    if (result.status === 'EXPIRED') return { status: 'expired' };
    if (result.status === 'FAIL') return { status: 'denied' };
    throw new Error('DingTalk returned an unknown authorization status');
  }
}

export function renderDingTalkQrCode(content: string) {
  return renderRegistrationQrCode(content, 'DingTalk');
}

async function postJson(fetchImpl: typeof fetch, url: string, value: Record<string, string>, signal: AbortSignal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  const body = await response.json().catch(() => undefined) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('DingTalk returned an invalid authorization response');
  }
  if (!response.ok) throw new Error(`DingTalk authorization request failed (HTTP ${response.status})`);
  return body as Record<string, unknown>;
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
