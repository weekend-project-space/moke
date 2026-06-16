import { ChatOpenAI } from '@langchain/openai';

export function createChatModel() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    temperature: 0,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 15000),
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
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
