import { ChatOpenAI } from '@langchain/openai';

export type ChatModelSettings = {
  apiKey: string;
  apiBaseUrl: string;
  maxRetries: number;
  model: string;
  timeoutMs: number;
};

export function resolveChatModelSettings(input: Partial<ChatModelSettings> = {}): ChatModelSettings {
  return {
    apiKey: input.apiKey || process.env.OPENAI_API_KEY || 'test',
    apiBaseUrl: input.apiBaseUrl || process.env.OPENAI_BASE_URL || 'http://localhost:8080/v1',
    maxRetries: input.maxRetries ?? Number(process.env.OPENAI_MAX_RETRIES || 3),
    model: input.model || process.env.OPENAI_MODEL || 'qwen3.6-35BA3B',
    timeoutMs: input.timeoutMs || Number(process.env.OPENAI_TIMEOUT_MS || 30 * 60 * 1000),
  };
}

export function createChatModel(input: Partial<ChatModelSettings> = {}) {
  const settings = resolveChatModelSettings(input);
  if (!settings.apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  return new ChatOpenAI({
    apiKey: settings.apiKey,
    maxRetries: settings.maxRetries,
    model: settings.model,
    temperature: 0,
    timeout: settings.timeoutMs,
    configuration: {
      baseURL: settings.apiBaseUrl,
      maxRetries: 0,
    },
  });
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Run cancelled');

  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM request timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  const abort = signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error('Run cancelled'));
        signal.addEventListener('abort', abortHandler, { once: true });
      })
    : undefined;

  try {
    return await Promise.race(abort ? [promise, timeout, abort] : [promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}
