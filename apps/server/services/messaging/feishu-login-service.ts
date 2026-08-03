import { randomUUID } from 'node:crypto';

import QRCode from 'qrcode';
import type { PublicMessagingConnection } from '../../storage/messaging-store.js';
import type { MessagingRuntime } from './messaging-runtime.js';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TTL_MS = 10 * 60_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 30_000;

export type FeishuLoginDomain = 'feishu' | 'lark';

type LoginStatus = 'waiting_scan' | 'expired' | 'denied' | 'confirmed' | 'failed' | 'cancelled';

type RegistrationStart = {
  deviceCode: string;
  verificationUrl: string;
  pollIntervalMs: number;
  expiresInMs: number;
};

type RegistrationPoll =
  | { status: 'pending' | 'slow_down' }
  | { status: 'expired' | 'denied' }
  | { status: 'confirmed'; appId: string; appSecret: string };

export type FeishuRegistration = {
  start(domain: FeishuLoginDomain, signal: AbortSignal): Promise<RegistrationStart>;
  poll(domain: FeishuLoginDomain, deviceCode: string, signal: AbortSignal): Promise<RegistrationPoll>;
};

type Login = {
  id: string;
  domain: FeishuLoginDomain;
  deviceCode: string;
  qrImage: string;
  startedAt: number;
  expiresAt: number;
  pollIntervalMs: number;
  nextPollAt: number;
  status: LoginStatus;
  controller: AbortController;
  pollPromise?: Promise<PublicFeishuLogin>;
  connection?: PublicMessagingConnection;
  error?: { code: string; message: string };
};

export type PublicFeishuLogin = {
  id: string;
  status: LoginStatus;
  qr_image?: string;
  expires_at: string;
  next_poll_after_ms: number;
  connection?: PublicMessagingConnection;
  error?: { code: string; message: string };
};

type MessagingConnectionManager = Pick<MessagingRuntime, 'createConnection' | 'removeConnection'>;

export class FeishuLoginService {
  private readonly logins = new Map<string, Login>();

  constructor(
    private readonly messaging: MessagingConnectionManager,
    private readonly registration: FeishuRegistration = new OfficialFeishuRegistration(),
    private readonly now: () => number = Date.now,
  ) {}

  async start(input: { domain?: FeishuLoginDomain }) {
    this.purgeExpired();
    const domain = input.domain === 'lark' ? 'lark' : 'feishu';
    const controller = new AbortController();
    const result = await this.registration.start(domain, controller.signal);
    const now = this.now();
    const pollIntervalMs = clampPollInterval(result.pollIntervalMs);
    const login: Login = {
      id: `fsl_${randomUUID().slice(0, 8)}`,
      domain,
      deviceCode: result.deviceCode,
      qrImage: await renderFeishuQrCode(result.verificationUrl),
      startedAt: now,
      expiresAt: now + Math.max(1_000, result.expiresInMs || DEFAULT_LOGIN_TTL_MS),
      pollIntervalMs,
      nextPollAt: now + pollIntervalMs,
      status: 'waiting_scan',
      controller,
    };
    this.logins.set(login.id, login);
    return this.toPublic(login, true);
  }

  async get(loginId: string): Promise<PublicFeishuLogin> {
    const login = this.requireLogin(loginId);
    if (isTerminal(login.status)) return this.toPublic(login);
    if (login.expiresAt <= this.now()) {
      login.status = 'expired';
      login.controller.abort();
      return this.toPublic(login);
    }
    if (login.nextPollAt > this.now()) return this.toPublic(login);
    if (login.pollPromise) return login.pollPromise;

    const operation = this.poll(login).finally(() => {
      if (login.pollPromise === operation) login.pollPromise = undefined;
    });
    login.pollPromise = operation;
    return operation;
  }

  cancel(loginId: string) {
    const login = this.requireLogin(loginId);
    if (!isTerminal(login.status)) login.status = 'cancelled';
    login.controller.abort();
    login.deviceCode = '';
    login.qrImage = '';
    return this.toPublic(login);
  }

  close() {
    for (const login of this.logins.values()) login.controller.abort();
    this.logins.clear();
  }

  private async poll(login: Login): Promise<PublicFeishuLogin> {
    try {
      const result = await this.registration.poll(login.domain, login.deviceCode, login.controller.signal);
      if (login.status === 'cancelled') return this.toPublic(login);
      if (result.status === 'pending') {
        login.nextPollAt = this.now() + login.pollIntervalMs;
      } else if (result.status === 'slow_down') {
        login.pollIntervalMs = clampPollInterval(login.pollIntervalMs + 5_000);
        login.nextPollAt = this.now() + login.pollIntervalMs;
      } else if (result.status === 'expired' || result.status === 'denied') {
        login.status = result.status;
        login.controller.abort();
      } else if (result.status === 'confirmed') {
        const connection = await this.messaging.createConnection({
          platform: 'feishu',
          credentials: { appId: result.appId, appSecret: result.appSecret, domain: login.domain },
        });
        if (login.controller.signal.aborted) {
          if (connection) await this.messaging.removeConnection(connection.id);
          return this.toPublic(login);
        }
        if (!connection) throw new Error('Feishu connection was not created');
        login.connection = connection;
        login.status = 'confirmed';
        login.controller.abort();
        login.deviceCode = '';
        login.qrImage = '';
      } else {
        throw new Error('Feishu returned an unknown authorization status');
      }
    } catch (error) {
      if (login.status === 'cancelled') return this.toPublic(login);
      login.status = 'failed';
      login.error = {
        code: 'FEISHU_LOGIN_FAILED',
        message: publicErrorMessage(error),
      };
      login.controller.abort();
    }
    return this.toPublic(login);
  }

  private requireLogin(id: string) {
    const login = this.logins.get(id);
    if (!login) throw new Error('The Feishu authorization session does not exist or has expired');
    return login;
  }

  private purgeExpired() {
    const now = this.now();
    for (const [id, login] of this.logins) {
      if (login.expiresAt <= now || (isTerminal(login.status) && now - login.startedAt > DEFAULT_LOGIN_TTL_MS)) {
        login.controller.abort();
        this.logins.delete(id);
      }
    }
  }

  private toPublic(login: Login, includeQr = false): PublicFeishuLogin {
    return {
      id: login.id,
      status: login.status,
      ...(includeQr && login.qrImage ? { qr_image: login.qrImage } : {}),
      expires_at: new Date(login.expiresAt).toISOString(),
      next_poll_after_ms: Math.max(0, login.nextPollAt - this.now()),
      ...(login.connection ? { connection: login.connection } : {}),
      ...(login.error ? { error: login.error } : {}),
    };
  }
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

  async poll(domain: FeishuLoginDomain, deviceCode: string, signal: AbortSignal): Promise<RegistrationPoll> {
    const result = await postForm(this.fetchImpl, registrationEndpoint(domain), {
      action: 'poll',
      device_code: deviceCode,
    }, signal);
    if (typeof result.client_id === 'string' && typeof result.client_secret === 'string') {
      return { status: 'confirmed', appId: result.client_id, appSecret: result.client_secret };
    }
    if (result.error === 'authorization_pending') return { status: 'pending' };
    if (result.error === 'slow_down') return { status: 'slow_down' };
    if (result.error === 'expired_token') return { status: 'expired' };
    if (result.error === 'access_denied') return { status: 'denied' };
    throw new Error('Feishu returned an unknown authorization status');
  }
}

export function renderFeishuQrCode(content: string) {
  if (!content.trim()) throw new Error('Feishu QR code content is empty');
  return QRCode.toDataURL(content, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
}

async function postForm(fetchImpl: typeof fetch, url: string, values: Record<string, string>, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
    signal: AbortSignal.any([signal, timeout]),
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

function clampPollInterval(value: number) {
  if (!Number.isFinite(value)) return 5_000;
  return Math.min(Math.max(Math.round(value), MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function publicErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError') return 'Feishu authorization timed out. Try again.';
  if (error instanceof Error && /HTTP \d{3}/.test(error.message)) return error.message;
  return error instanceof Error && error.message ? error.message : 'Feishu authorization failed';
}

function isTerminal(status: LoginStatus) {
  return status === 'expired' || status === 'denied' || status === 'confirmed' || status === 'failed' || status === 'cancelled';
}
