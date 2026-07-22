import { randomUUID } from 'node:crypto';

import QRCode from 'qrcode';
import { WeixinApiClient, type WeixinQrStatus } from '@moke/messaging-weixin';
import { JsonMessagingStore, type PublicWeixinConnection } from '../../storage/messaging-store.js';
import { MessagingConnectionManager } from './connection-manager.js';

const LOGIN_TTL_MS = 5 * 60_000;

type Login = {
  id: string;
  name: string;
  qrcode: string;
  qrImage: string;
  startedAt: number;
  baseUrl?: string;
  verifyCode?: string;
  connectionId?: string;
  status: LoginStatus;
  connection?: PublicWeixinConnection;
  error?: { code: string; message: string };
};

type LoginStatus = 'waiting_scan' | 'scanned' | 'verify_required' | 'expired' | 'confirmed' | 'already_connected' | 'failed' | 'cancelled';

export class WeixinLoginService {
  private readonly logins = new Map<string, Login>();

  constructor(
    private readonly store: JsonMessagingStore,
    private readonly connections: MessagingConnectionManager,
  ) {}

  async start(input: { name?: string; connectionId?: string }) {
    this.purgeExpired();
    if (input.connectionId && !this.store.getWeixinConnection(input.connectionId)) throw new Error('Weixin connection not found');
    if (input.connectionId) await this.connections.stop(input.connectionId, 'reauth');
    const qr = await new WeixinApiClient({}).getQrCode();
    // qrcode identifies this login flow for status polling. qrcode_img_content is
    // the payload users must scan, as confirmed by Tencent's reference channel.
    const qrImage = await renderWeixinQrCode(qr.qrcode_img_content);
    const login: Login = {
      id: `wxl_${randomUUID().slice(0, 8)}`,
      name: input.name?.trim() || 'WeChat',
      qrcode: qr.qrcode,
      qrImage,
      startedAt: Date.now(),
      connectionId: input.connectionId,
      status: 'waiting_scan',
    };
    this.logins.set(login.id, login);
    return this.toPublic(login);
  }

  async get(loginId: string) {
    const login = this.requireLogin(loginId);
    if (isTerminal(login.status)) return this.toPublic(login);
    if (Date.now() - login.startedAt > LOGIN_TTL_MS) {
      login.status = 'expired';
      return this.toPublic(login);
    }
    const client = new WeixinApiClient({ baseUrl: login.baseUrl });
    try {
      const status = await client.getQrStatus(login.qrcode, login.verifyCode);
      await this.applyStatus(login, status);
    } catch (error) {
      login.status = 'failed';
      login.error = { code: 'WEIXIN_LOGIN_FAILED', message: error instanceof Error ? error.message : 'WeChat authorization failed' };
    }
    return this.toPublic(login);
  }

  async verify(loginId: string, code: string) {
    const login = this.requireLogin(loginId);
    if (isTerminal(login.status)) return this.toPublic(login);
    login.verifyCode = code;
    return this.get(loginId);
  }

  cancel(loginId: string) {
    const login = this.requireLogin(loginId);
    login.status = 'cancelled';
    login.qrcode = '';
    return this.toPublic(login);
  }

  private async applyStatus(login: Login, status: WeixinQrStatus) {
    if (status.status === 'scaned_but_redirect' && status.redirect_host && /^[A-Za-z0-9.-]+$/.test(status.redirect_host)) {
      login.baseUrl = `https://${status.redirect_host}`;
      login.status = 'scanned';
      return;
    }
    if (status.status === 'wait') login.status = 'waiting_scan';
    if (status.status === 'scaned') {
      login.verifyCode = undefined;
      login.status = 'scanned';
    }
    if (status.status === 'need_verifycode') login.status = 'verify_required';
    if (status.status === 'verify_code_blocked') {
      login.status = 'failed';
      login.error = { code: 'WEIXIN_VERIFY_BLOCKED', message: 'Too many verification attempts. Start authorization again.' };
    }
    if (status.status === 'expired') login.status = 'expired';
    if (status.status === 'binded_redirect') login.status = 'already_connected';
    if (status.status !== 'confirmed') return;
    if (!status.bot_token || !status.ilink_bot_id) {
      login.status = 'failed';
      login.error = { code: 'WEIXIN_INVALID_RESPONSE', message: 'The WeChat authorization response is missing account credentials' };
      return;
    }
    const record = login.connectionId
      ? this.store.replaceConnectionAuth(login.connectionId, {
          ilinkBotId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          apiBaseUrl: status.baseurl || login.baseUrl || 'https://ilinkai.weixin.qq.com',
          token: status.bot_token,
        })
      : this.store.createConnection({
          name: login.name,
          ilinkBotId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          apiBaseUrl: status.baseurl || login.baseUrl || 'https://ilinkai.weixin.qq.com',
          token: status.bot_token,
        });
    login.connection = this.store.getPublicWeixinConnection(record.id) || undefined;
    login.status = 'confirmed';
    await this.connections.start(record.id);
  }

  private requireLogin(id: string) {
    const login = this.logins.get(id);
    if (!login) throw new Error('The WeChat authorization session does not exist or has expired');
    return login;
  }

  private purgeExpired() {
    for (const [id, login] of this.logins) {
      if (!isTerminal(login.status) && Date.now() - login.startedAt > LOGIN_TTL_MS) this.logins.delete(id);
    }
  }

  private toPublic(login: Login) {
    return {
      id: login.id,
      status: login.status,
      qr_image: login.qrImage || undefined,
      expires_at: new Date(login.startedAt + LOGIN_TTL_MS).toISOString(),
      ...(login.connection ? { connection: login.connection } : {}),
      ...(login.error ? { error: login.error } : {}),
    };
  }
}

export function renderWeixinQrCode(content: string) {
  if (!content.trim()) throw new Error('WeChat QR code content is empty');
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  });
}

function isTerminal(status: LoginStatus) {
  return status === 'expired' || status === 'confirmed' || status === 'already_connected' || status === 'failed' || status === 'cancelled';
}
