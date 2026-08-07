import type { MessagingRuntime } from './messaging-runtime.js';
import {
  RegistrationLoginService,
  renderRegistrationQrCode,
  type PublicRegistrationLogin,
  type RegistrationPoll,
  type RegistrationStart,
} from './registration-login-service.js';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TTL_MS = 10 * 60_000;

export type FeishuLoginDomain = 'feishu' | 'lark';

type FeishuCredential = { appId: string; appSecret: string };

export type FeishuRegistration = {
  start(domain: FeishuLoginDomain, signal: AbortSignal): Promise<RegistrationStart>;
  poll(domain: FeishuLoginDomain, deviceCode: string, signal: AbortSignal): Promise<RegistrationPoll<FeishuCredential>>;
};

export type PublicFeishuLogin = PublicRegistrationLogin;

type MessagingConnectionManager = Pick<MessagingRuntime, 'createConnection' | 'removeConnection'>;

export class FeishuLoginService {
  private readonly service: RegistrationLoginService<{ domain: FeishuLoginDomain }, FeishuCredential>;

  constructor(
    messaging: MessagingConnectionManager,
    registration: FeishuRegistration = new OfficialFeishuRegistration(),
    now: () => number = Date.now,
  ) {
    this.service = new RegistrationLoginService({
      idPrefix: 'fsl',
      platformName: 'Feishu',
      failureCode: 'FEISHU_LOGIN_FAILED',
      defaultExpiresInMs: DEFAULT_LOGIN_TTL_MS,
      registration: {
        start: (input, signal) => registration.start(input.domain, signal),
        poll: (input, deviceCode, signal) => registration.poll(input.domain, deviceCode, signal),
      },
      connect: (credential, input) => messaging.createConnection({
        platform: 'feishu',
        credentials: { ...credential, domain: input.domain },
      }),
      removeConnection: (connectionId) => messaging.removeConnection(connectionId),
      now,
    });
  }

  start(input: { domain?: FeishuLoginDomain }) {
    return this.service.start({ domain: input.domain === 'lark' ? 'lark' : 'feishu' });
  }

  get(loginId: string) { return this.service.get(loginId); }
  cancel(loginId: string) { return this.service.cancel(loginId); }
  close() { this.service.close(); }
}

export class OfficialFeishuRegistration implements FeishuRegistration {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async start(domain: FeishuLoginDomain, signal: AbortSignal): Promise<RegistrationStart> {
    const endpoint = registrationEndpoint(domain);
    const init = await postForm(this.fetchImpl, endpoint, { action: 'init' }, signal);
    if (!Array.isArray(init.supported_auth_methods) || !init.supported_auth_methods.includes('client_secret')) {
      throw new Error('Feishu quick authorization is not available for this account');
    }
    const begin = await postForm(this.fetchImpl, endpoint, {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    }, signal);
    if (typeof begin.device_code !== 'string' || typeof begin.verification_uri_complete !== 'string') {
      throw new Error('Feishu returned an invalid authorization response');
    }
    const verificationUrl = new URL(begin.verification_uri_complete);
    if (verificationUrl.protocol !== 'https:') throw new Error('Feishu returned an invalid authorization URL');
    verificationUrl.searchParams.set('from', 'moke');
    return {
      deviceCode: begin.device_code,
      verificationUrl: verificationUrl.toString(),
      pollIntervalMs: numberValue(begin.interval, 5) * 1_000,
      expiresInMs: numberValue(begin.expire_in ?? begin.expires_in, DEFAULT_LOGIN_TTL_MS / 1_000) * 1_000,
    };
  }

  async poll(domain: FeishuLoginDomain, deviceCode: string, signal: AbortSignal): Promise<RegistrationPoll<FeishuCredential>> {
    const result = await postForm(this.fetchImpl, registrationEndpoint(domain), {
      action: 'poll',
      device_code: deviceCode,
    }, signal);
    if (typeof result.client_id === 'string' && typeof result.client_secret === 'string') {
      return { status: 'confirmed', credential: { appId: result.client_id, appSecret: result.client_secret } };
    }
    if (result.error === 'authorization_pending') return { status: 'pending' };
    if (result.error === 'slow_down') return { status: 'slow_down' };
    if (result.error === 'expired_token') return { status: 'expired' };
    if (result.error === 'access_denied') return { status: 'denied' };
    throw new Error('Feishu returned an unknown authorization status');
  }
}

export function renderFeishuQrCode(content: string) {
  return renderRegistrationQrCode(content, 'Feishu');
}

async function postForm(fetchImpl: typeof fetch, url: string, values: Record<string, string>, signal: AbortSignal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  const body = await response.json().catch(() => undefined) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Feishu returned an invalid authorization response');
  }
  const record = body as Record<string, unknown>;
  if (!response.ok && typeof record.error !== 'string') {
    throw new Error(`Feishu authorization request failed (HTTP ${response.status})`);
  }
  return record;
}

function registrationEndpoint(domain: FeishuLoginDomain) {
  return domain === 'lark'
    ? 'https://accounts.larksuite.com/oauth/v1/app/registration'
    : 'https://accounts.feishu.cn/oauth/v1/app/registration';
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
