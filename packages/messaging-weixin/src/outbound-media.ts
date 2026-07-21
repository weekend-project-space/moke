import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { WEIXIN_CDN_BASE_URL } from './constants.js';
import { WeixinApiClient, WeixinApiError, type WeixinOutboundItem } from './api-client.js';

export type WeixinOutboundMedia = {
  type: 'image' | 'file';
  data: Buffer;
  name: string;
  mimeType: string;
};

export async function uploadWeixinMedia(input: {
  client: WeixinApiClient;
  toUserId: string;
  media: WeixinOutboundMedia;
  signal?: AbortSignal;
}) {
  const aesKey = randomBytes(16);
  const cipher = createCipheriv('aes-128-ecb', aesKey, null);
  const encrypted = Buffer.concat([cipher.update(input.media.data), cipher.final()]);
  const filekey = randomBytes(16).toString('hex');
  const upload = await input.client.getUploadUrl({
    filekey,
    mediaType: input.media.type === 'image' ? 1 : 3,
    toUserId: input.toUserId,
    rawsize: input.media.data.length,
    rawfilemd5: createHash('md5').update(input.media.data).digest('hex'),
    filesize: encrypted.length,
    aeskey: aesKey.toString('hex'),
    signal: input.signal,
  });
  const uploadUrl = upload.upload_full_url || (upload.upload_param
    ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`
    : '');
  if (!uploadUrl) throw new Error('Weixin upload URL is missing');
  const encryptedQueryParam = await uploadWithRetry(input.client, uploadUrl, encrypted, input.signal);
  const media = {
    encrypt_query_param: encryptedQueryParam,
    // iLink expects Base64 of the hexadecimal key text, not raw key bytes.
    aes_key: Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64'),
    encrypt_type: 1,
  };
  const item: WeixinOutboundItem = input.media.type === 'image'
    ? { type: 2, image_item: { media, mid_size: encrypted.length } }
    : { type: 4, file_item: { media, file_name: input.media.name, len: String(input.media.data.length) } };
  return { item };
}

async function uploadWithRetry(client: WeixinApiClient, uploadUrl: string, data: Buffer, signal?: AbortSignal) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.uploadCdn({ uploadUrl, data, signal });
    } catch (error) {
      lastError = error;
      if (!(error instanceof WeixinApiError) || !error.retryable || attempt === 2 || signal?.aborted) throw error;
      await wait(250 * 2 ** attempt, signal);
    }
  }
  throw lastError;
}

function wait(delayMs: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  const abortSignal = signal;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    function done() {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}
