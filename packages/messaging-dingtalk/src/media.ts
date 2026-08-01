const DINGTALK_API = 'https://api.dingtalk.com';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type DingTalkMediaCandidate = {
  kind: 'image' | 'file';
  url?: string;
  downloadCode?: string;
  fileName?: string;
};

export async function downloadDingTalkImage(input: {
  candidate: DingTalkMediaCandidate;
  robotCode: string;
  accessToken: string;
  fetcher?: typeof fetch;
}) {
  const fetcher = input.fetcher || fetch;
  const url = input.candidate.url || await resolveDownloadUrl(input.candidate.downloadCode, input.robotCode, input.accessToken, fetcher);
  if (!url) throw new Error('DingTalk image is missing a download URL');
  assertSafeDownloadUrl(url);
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`DingTalk image download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('DingTalk image exceeds the 5 MB input limit');
  return data;
}

function assertSafeDownloadUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('DingTalk image URL is invalid'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || host === 'localhost' || host === '::1' || /^127\./.test(host) || /^10\./.test(host)
    || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('DingTalk image URL is not trusted');
  }
}

async function resolveDownloadUrl(code: string | undefined, robotCode: string, token: string, fetcher: typeof fetch) {
  if (!code) return undefined;
  const response = await fetcher(`${DINGTALK_API}/v1.0/robot/messageFiles/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({ downloadCode: code, robotCode }),
  });
  const body = await response.json().catch(() => null) as { downloadUrl?: string; message?: string } | null;
  if (!response.ok || !body?.downloadUrl) throw new Error(body?.message || `DingTalk media URL request failed: HTTP ${response.status}`);
  return body.downloadUrl;
}
