const DINGTALK_API = 'https://api.dingtalk.com';

export class DingTalkAccessTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async get() {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token;
    const response = await this.fetcher(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
    });
    const body = await response.json().catch(() => null) as { accessToken?: string; expireIn?: number; message?: string } | null;
    if (!response.ok || !body?.accessToken) throw new Error(body?.message || `DingTalk access token request failed: HTTP ${response.status}`);
    this.cached = {
      token: body.accessToken,
      expiresAt: Date.now() + Math.max(60, Number(body.expireIn) || 7_200) * 1_000,
    };
    return this.cached.token;
  }
}
