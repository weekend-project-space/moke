import { randomBytes } from 'node:crypto';

import {
  WEIXIN_API_BASE_URL,
  WEIXIN_APP_CLIENT_VERSION,
  WEIXIN_BOT_AGENT,
  WEIXIN_BOT_TYPE,
  WEIXIN_CHANNEL_VERSION,
  WEIXIN_LONG_POLL_TIMEOUT_MS,
} from './constants.js';

export type WeixinMessageItem = {
  type?: number;
  text_item?: { text?: string };
  ref_msg?: { message_id?: string | number; text?: string };
  image_item?: {
    aeskey?: string;
    url?: string;
    media?: { full_url?: string; encrypt_query_param?: string; aes_key?: string };
  };
};

export type WeixinInboundMessage = {
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
};

export type WeixinUpdatesResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};

export type WeixinOutboundItem = Record<string, unknown>;

export type WeixinQrCode = {
  qrcode: string;
  qrcode_img_content: string;
};

export type WeixinQrStatus = {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
};

export class WeixinApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

export class WeixinApiClient {
  constructor(
    private readonly input: {
      token?: string;
      baseUrl?: string;
      fetch?: FetchLike;
    },
  ) {}

  async getQrCode(signal?: AbortSignal) {
    const response = await this.request<Partial<WeixinQrCode>>(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WEIXIN_BOT_TYPE)}`,
      { local_token_list: [] },
      { signal, authenticated: false },
    );
    if (typeof response.qrcode !== 'string' || typeof response.qrcode_img_content !== 'string') {
      throw new WeixinApiError('WEIXIN_INVALID_RESPONSE', 'WeChat returned an invalid QR code response', false);
    }
    return response as WeixinQrCode;
  }

  async getQrStatus(qrcode: string, verifyCode?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ qrcode });
    if (verifyCode) query.set('verify_code', verifyCode);
    const response = await this.request<Partial<WeixinQrStatus>>(
      `ilink/bot/get_qrcode_status?${query.toString()}`,
      undefined,
      { signal, authenticated: false, method: 'GET', timeoutMs: WEIXIN_LONG_POLL_TIMEOUT_MS },
    );
    if (!isQrStatus(response.status)) {
      throw new WeixinApiError('WEIXIN_INVALID_RESPONSE', 'WeChat returned an invalid authorization status response', false);
    }
    return response as WeixinQrStatus;
  }

  async getUpdates(cursor: string, signal?: AbortSignal, timeoutMs = WEIXIN_LONG_POLL_TIMEOUT_MS) {
    const response = await this.request<WeixinUpdatesResponse>(
      'ilink/bot/getupdates',
      { get_updates_buf: cursor, base_info: baseInfo() },
      { signal, timeoutMs },
    );
    if (!Array.isArray(response.msgs) && response.msgs !== undefined) {
      throw new WeixinApiError('WEIXIN_INVALID_RESPONSE', 'WeChat returned an invalid message response', false);
    }
    return response;
  }

  async sendText(input: { toUserId: string; contextToken?: string; text: string; signal?: AbortSignal }) {
    await this.sendItems({
      toUserId: input.toUserId,
      contextToken: input.contextToken,
      items: [{ type: 1, text_item: { text: input.text } }],
      signal: input.signal,
    });
  }

  async sendItems(input: { toUserId: string; contextToken?: string; items: WeixinOutboundItem[]; runId?: string; signal?: AbortSignal }) {
    const response = await this.request<{ ret?: number; errmsg?: string }>('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: input.toUserId,
        client_id: `openclaw-weixin:${Date.now()}-${randomBytes(4).toString('hex')}`,
        message_type: 2,
        message_state: 2,
        context_token: input.contextToken,
        ...(input.runId ? { run_id: input.runId } : {}),
        item_list: input.items,
      },
      base_info: baseInfo(),
    }, { signal: input.signal, timeoutMs: 15_000 });
    if (response.ret && response.ret !== 0) {
      throw new WeixinApiError('WEIXIN_DELIVERY_FAILED', response.errmsg || 'Failed to send the WeChat message', response.ret >= 500);
    }
  }

  async getUploadUrl(input: {
    filekey: string;
    mediaType: 1 | 3;
    toUserId: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
    signal?: AbortSignal;
  }) {
    const response = await this.request<{ ret?: number; errmsg?: string; upload_param?: string; upload_full_url?: string }>(
      'ilink/bot/getuploadurl',
      {
        filekey: input.filekey,
        media_type: input.mediaType,
        to_user_id: input.toUserId,
        rawsize: input.rawsize,
        rawfilemd5: input.rawfilemd5,
        filesize: input.filesize,
        no_need_thumb: true,
        aeskey: input.aeskey,
        base_info: baseInfo(),
      },
      { signal: input.signal, timeoutMs: 15_000 },
    );
    if (response.ret && response.ret !== 0) {
      throw new WeixinApiError('WEIXIN_UPLOAD_URL_FAILED', response.errmsg || 'Failed to get a WeChat media upload URL', response.ret >= 500);
    }
    return response;
  }

  async uploadCdn(input: { uploadUrl: string; data: Uint8Array; signal?: AbortSignal }) {
    const url = new URL(input.uploadUrl);
    if (url.protocol !== 'https:') throw new WeixinApiError('WEIXIN_CDN_URL_INVALID', 'The WeChat CDN upload URL must use HTTPS', false);
    const fetchImpl = this.input.fetch || fetch;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: input.data as unknown as BodyInit,
      signal: input.signal,
    });
    if (!response.ok) {
      throw new WeixinApiError('WEIXIN_CDN_UPLOAD_FAILED', `WeChat CDN upload failed (${response.status})`, response.status >= 500 || response.status === 429);
    }
    const encryptedParam = response.headers.get('x-encrypted-param');
    if (!encryptedParam) throw new WeixinApiError('WEIXIN_CDN_UPLOAD_FAILED', 'The WeChat CDN response is missing the download parameter', true);
    return encryptedParam;
  }

  async getConfig(input: { userId: string; contextToken?: string; signal?: AbortSignal }) {
    const response = await this.request<{ ret?: number; errmsg?: string; typing_ticket?: string }>('ilink/bot/getconfig', {
      ilink_user_id: input.userId,
      context_token: input.contextToken,
      base_info: baseInfo(),
    }, { signal: input.signal, timeoutMs: 10_000 });
    if (response.ret && response.ret !== 0) {
      throw new WeixinApiError('WEIXIN_CONFIG_FAILED', response.errmsg || 'Failed to get WeChat typing configuration', response.ret >= 500);
    }
    return response;
  }

  async sendTypingWithTicket(input: { userId: string; typingTicket: string; status: 1 | 2; signal?: AbortSignal }) {
    const response = await this.request<{ ret?: number; errmsg?: string }>('ilink/bot/sendtyping', {
      ilink_user_id: input.userId,
      typing_ticket: input.typingTicket,
      status: input.status,
      base_info: baseInfo(),
    }, { signal: input.signal, timeoutMs: 10_000 });
    if (response.ret && response.ret !== 0) {
      throw new WeixinApiError('WEIXIN_TYPING_FAILED', response.errmsg || 'Failed to send WeChat typing status', response.ret >= 500);
    }
  }

  private async request<T>(
    endpoint: string,
    body: unknown,
    options: {
      signal?: AbortSignal;
      authenticated?: boolean;
      method?: 'GET' | 'POST';
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const fetchImpl = this.input.fetch || fetch;
    const url = new URL(endpoint, normalizedBaseUrl(this.input.baseUrl)).toString();
    const controller = new AbortController();
    const timeout = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
    const signal = mergeAbortSignals(controller, options.signal);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(WEIXIN_APP_CLIENT_VERSION),
      'X-WECHAT-UIN': randomWechatUin(),
    };
    if (options.authenticated !== false) {
      const token = this.input.token?.trim();
      if (!token) throw new WeixinApiError('WEIXIN_AUTH_MISSING', 'WeChat authorization is missing', false);
      headers.AuthorizationType = 'ilink_bot_token';
      headers.Authorization = `Bearer ${token}`;
    }
    try {
      const response = await fetchImpl(url, {
        method: options.method || 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new WeixinApiError(
          'WEIXIN_HTTP_ERROR',
          `WeChat API request failed (${response.status})`,
          response.status >= 500 || response.status === 429,
        );
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new WeixinApiError('WEIXIN_INVALID_RESPONSE', 'WeChat returned invalid JSON', false);
      }
    } catch (error) {
      if (error instanceof WeixinApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new WeixinApiError('WEIXIN_TIMEOUT', 'The WeChat API request timed out', true);
      }
      throw new WeixinApiError('WEIXIN_NETWORK_ERROR', 'Could not connect to WeChat', true);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function normalizedBaseUrl(baseUrl = WEIXIN_API_BASE_URL) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') throw new Error('Weixin API URL must use HTTPS');
  return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`;
}

function mergeAbortSignals(controller: AbortController, external?: AbortSignal) {
  if (!external) return controller.signal;
  if (external.aborted) controller.abort();
  else external.addEventListener('abort', () => controller.abort(), { once: true });
  return controller.signal;
}

function randomWechatUin() {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function baseInfo() {
  return {
    channel_version: WEIXIN_CHANNEL_VERSION,
    bot_agent: WEIXIN_BOT_AGENT,
  };
}

function isQrStatus(value: unknown): value is WeixinQrStatus['status'] {
  return value === 'wait'
    || value === 'scaned'
    || value === 'confirmed'
    || value === 'expired'
    || value === 'scaned_but_redirect'
    || value === 'need_verifycode'
    || value === 'verify_code_blocked'
    || value === 'binded_redirect';
}
