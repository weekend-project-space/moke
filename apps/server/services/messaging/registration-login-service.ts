import { randomUUID } from 'node:crypto';

import QRCode from 'qrcode';
import type { PublicMessagingConnection } from '../../storage/messaging-store.js';

const RETAIN_TERMINAL_MS = 10 * 60_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 30_000;

export type RegistrationStart = {
  deviceCode: string;
  verificationUrl: string;
  pollIntervalMs: number;
  expiresInMs: number;
};

export type RegistrationPoll<TCredential> =
  | { status: 'pending' | 'slow_down' }
  | { status: 'expired' | 'denied' }
  | { status: 'confirmed'; credential: TCredential };

export type RegistrationAdapter<TInput, TCredential> = {
  start(input: TInput, signal: AbortSignal): Promise<RegistrationStart>;
  poll(input: TInput, deviceCode: string, signal: AbortSignal): Promise<RegistrationPoll<TCredential>>;
};

type LoginStatus = 'waiting_scan' | 'expired' | 'denied' | 'confirmed' | 'failed' | 'cancelled';

type Login<TInput> = {
  id: string;
  input: TInput;
  deviceCode: string;
  qrImage: string;
  startedAt: number;
  expiresAt: number;
  pollIntervalMs: number;
  nextPollAt: number;
  status: LoginStatus;
  controller: AbortController;
  pollPromise?: Promise<PublicRegistrationLogin>;
  connection?: PublicMessagingConnection;
  error?: { code: string; message: string };
};

export type PublicRegistrationLogin = {
  id: string;
  status: LoginStatus;
  qr_image?: string;
  expires_at: string;
  next_poll_after_ms: number;
  connection?: PublicMessagingConnection;
  error?: { code: string; message: string };
};

export type RegistrationLoginOptions<TInput, TCredential> = {
  idPrefix: string;
  platformName: string;
  failureCode: string;
  defaultExpiresInMs: number;
  registration: RegistrationAdapter<TInput, TCredential>;
  connect(credential: TCredential, input: TInput): Promise<PublicMessagingConnection | null>;
  removeConnection(connectionId: string): Promise<void>;
  now?: () => number;
};

export class RegistrationLoginService<TInput, TCredential> {
  private readonly logins = new Map<string, Login<TInput>>();
  private readonly now: () => number;

  constructor(private readonly options: RegistrationLoginOptions<TInput, TCredential>) {
    this.now = options.now ?? Date.now;
  }

  async start(input: TInput) {
    this.purgeExpired();
    const controller = new AbortController();
    try {
      const result = await this.options.registration.start(input, controller.signal);
      const now = this.now();
      const pollIntervalMs = clampPollInterval(result.pollIntervalMs);
      const login: Login<TInput> = {
        id: `${this.options.idPrefix}_${randomUUID().slice(0, 8)}`,
        input,
        deviceCode: result.deviceCode,
        qrImage: await renderRegistrationQrCode(result.verificationUrl, this.options.platformName),
        startedAt: now,
        expiresAt: now + Math.max(1_000, result.expiresInMs || this.options.defaultExpiresInMs),
        pollIntervalMs,
        nextPollAt: now + pollIntervalMs,
        status: 'waiting_scan',
        controller,
      };
      this.logins.set(login.id, login);
      return this.toPublic(login, true);
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  async get(loginId: string): Promise<PublicRegistrationLogin> {
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

  private async poll(login: Login<TInput>): Promise<PublicRegistrationLogin> {
    try {
      const result = await this.options.registration.poll(login.input, login.deviceCode, login.controller.signal);
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
        const connection = await this.options.connect(result.credential, login.input);
        if (login.controller.signal.aborted) {
          if (connection) await this.options.removeConnection(connection.id);
          return this.toPublic(login);
        }
        if (!connection) throw new Error(`${this.options.platformName} connection was not created`);
        login.connection = connection;
        login.status = 'confirmed';
        login.controller.abort();
        login.deviceCode = '';
        login.qrImage = '';
      }
    } catch (error) {
      if (login.status === 'cancelled') return this.toPublic(login);
      login.status = 'failed';
      login.error = {
        code: this.options.failureCode,
        message: publicErrorMessage(error, this.options.platformName),
      };
      login.controller.abort();
    }
    return this.toPublic(login);
  }

  private requireLogin(id: string) {
    const login = this.logins.get(id);
    if (!login) throw new Error(`The ${this.options.platformName} authorization session does not exist or has expired`);
    return login;
  }

  private purgeExpired() {
    const now = this.now();
    for (const [id, login] of this.logins) {
      if (login.expiresAt <= now || (isTerminal(login.status) && now - login.startedAt > RETAIN_TERMINAL_MS)) {
        login.controller.abort();
        this.logins.delete(id);
      }
    }
  }

  private toPublic(login: Login<TInput>, includeQr = false): PublicRegistrationLogin {
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

export function renderRegistrationQrCode(content: string, platformName: string) {
  if (!content.trim()) throw new Error(`${platformName} QR code content is empty`);
  return QRCode.toDataURL(content, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
}

function clampPollInterval(value: number) {
  if (!Number.isFinite(value)) return 5_000;
  return Math.min(Math.max(Math.round(value), MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
}

function publicErrorMessage(error: unknown, platformName: string) {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `${platformName} authorization timed out. Try again.`;
  }
  if (error instanceof Error && error.message) return error.message;
  return `${platformName} authorization failed`;
}

function isTerminal(status: LoginStatus) {
  return status === 'expired' || status === 'denied' || status === 'confirmed' || status === 'failed' || status === 'cancelled';
}
