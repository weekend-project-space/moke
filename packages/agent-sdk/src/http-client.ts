import type { ApiErrorResponse } from '@moke/protocol';
import { MokeApiError, MokeNetworkError, MokeProtocolError } from './errors.js';
import type { MokeClientOptions, RequestOptions } from './types.js';

export class HttpClient {
  readonly baseUrl: string;
  readonly fetcher: typeof fetch;
  private readonly token?: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: MokeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetcher = (options.fetch || fetch).bind(globalThis);
    this.token = options.token;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  headers(extra?: HeadersInit) {
    const headers = new Headers(extra);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }

  async request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeout > 0 ? setTimeout(() => controller.abort(new Error('Request timed out')), timeout) : undefined;

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.headers),
        signal: controller.signal,
      });
      if (!response.ok) throw await readApiError(response);
      try {
        return await response.json() as T;
      } catch (error) {
        throw new MokeProtocolError(`Server returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      if (error instanceof MokeApiError || error instanceof MokeProtocolError) throw error;
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      throw new MokeNetworkError(error instanceof Error ? error.message : 'Network request failed', { cause: error });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  json(method: 'POST' | 'PATCH', body: unknown): RequestInit {
    return {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }
}

async function readApiError(response: Response) {
  try {
    const body = await response.json() as Partial<ApiErrorResponse>;
    const code = typeof body.error?.code === 'string' ? body.error.code : 'HTTP_ERROR';
    const message = typeof body.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
    return new MokeApiError(response.status, code, message, body.error?.details);
  } catch {
    return new MokeApiError(response.status, 'HTTP_ERROR', `HTTP ${response.status}`);
  }
}
