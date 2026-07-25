import { createDecipheriv } from 'node:crypto';
import { WEIXIN_CDN_BASE_URL } from './constants.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function downloadWeixinImage(
  input: { downloadUrl?: string; encryptedQueryParam?: string; aesKey?: string; aeskey?: string },
  fetchImpl: typeof fetch = fetch,
) {
  const url = new URL(input.downloadUrl || `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(input.encryptedQueryParam || '')}`);
  if (url.protocol !== 'https:') throw new Error('Weixin image URL must use HTTPS');
  if (!isTrustedWeixinCdn(url)) throw new Error('Weixin image URL host is not trusted');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Weixin image download failed (${response.status})`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES + 32) {
    throw new Error('Weixin image is too large');
  }
  const downloaded = await readLimitedBody(response, MAX_IMAGE_BYTES + 32);
  const key = resolveAesKey(input);
  const image = key ? decryptAesEcb(downloaded, key) : downloaded;
  if (image.length > MAX_IMAGE_BYTES) throw new Error('Weixin image is too large');
  return image;
}

async function readLimitedBody(response: Response, limit: number) {
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > limit) throw new Error('Weixin image is too large');
    return data;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Weixin image is too large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function isTrustedWeixinCdn(url: URL) {
  const host = url.hostname.toLowerCase();
  return host === 'qq.com'
    || host.endsWith('.qq.com')
    || host === 'qpic.cn'
    || host.endsWith('.qpic.cn');
}

function resolveAesKey(input: { aesKey?: string; aeskey?: string }) {
  if (input.aeskey) {
    if (!/^[0-9a-fA-F]{32}$/.test(input.aeskey)) throw new Error('Weixin image AES key is invalid');
    return Buffer.from(input.aeskey, 'hex');
  }
  if (!input.aesKey) return undefined;
  const decoded = Buffer.from(input.aesKey, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error('Weixin image AES key is invalid');
}

function decryptAesEcb(data: Buffer, key: Buffer) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
