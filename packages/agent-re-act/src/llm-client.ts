import { ChatOpenAI } from '@langchain/openai';

import type { ReasoningEffort } from '../../protocol/src/index.js';

export type ChatModelSettings = {
  apiKey: string;
  apiBaseUrl: string;
  maxRetries: number;
  model: string;
  type: 'openai-compatible' | 'openai-responses';
  reasoningEffort: ReasoningEffort;
  reasoningProvider: 'none' | 'llama.cpp';
  showRawReasoning: boolean;
  timeoutMs: number;
};

export function normalizeReasoningEffort(input: unknown): ChatModelSettings['reasoningEffort'] {
  if (input === 'ultra') return 'max';
  return input === 'off' || input === 'low' || input === 'medium' || input === 'high' || input === 'max' ? input : 'medium';
}

export function normalizeReasoningProvider(input: unknown): ChatModelSettings['reasoningProvider'] {
  return input === 'llama.cpp' ? input : 'none';
}

function normalizeBoolean(input: unknown, fallback = false) {
  if (typeof input === 'boolean') return input;
  if (input === 'true') return true;
  if (input === 'false') return false;
  return fallback;
}

function llamaCppThinkingBudget(reasoningEffort: ChatModelSettings['reasoningEffort']) {
  switch (reasoningEffort) {
    case 'low':
      return 256;
    case 'medium':
      return 512;
    case 'high':
      return 1024;
    case 'max':
      return 2048;
    default:
      return 0;
  }
}

export function createModelKwargs(settings: ChatModelSettings): Record<string, unknown> {
  if (settings.reasoningProvider !== 'llama.cpp') return {};

  const enableThinking = settings.reasoningEffort !== 'off';
  return {
    return_progress: settings.showRawReasoning && enableThinking,
    reasoning_format: 'auto',
    chat_template_kwargs: {
      enable_thinking: enableThinking,
    },
    thinking_budget_tokens: llamaCppThinkingBudget(settings.reasoningEffort),
    reasoning_control: true,
    backend_sampling: false,
  };
}

function normalizeMaxRetries(input: unknown) {
  const maxRetries = Number(input);
  const normalized = Number.isFinite(maxRetries) ? Math.trunc(maxRetries) : 3;
  return Math.max(0, Math.min(normalized, 6));
}

export function resolveChatModelSettings(input: Partial<ChatModelSettings> = {}): ChatModelSettings {
  return {
    apiKey: input.apiKey || process.env.OPENAI_API_KEY || 'test',
    apiBaseUrl: input.apiBaseUrl || process.env.OPENAI_BASE_URL || 'http://localhost:8080/v1',
    maxRetries: normalizeMaxRetries(input.maxRetries ?? process.env.OPENAI_MAX_RETRIES),
    model: input.model || process.env.OPENAI_MODEL || 'qwen3.6-35BA3B',
    type: input.type === 'openai-responses' ? 'openai-responses' : 'openai-compatible',
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort ?? process.env.OPENAI_REASONING_EFFORT),
    reasoningProvider: normalizeReasoningProvider(input.reasoningProvider ?? process.env.OPENAI_REASONING_PROVIDER),
    showRawReasoning: normalizeBoolean(input.showRawReasoning ?? process.env.OPENAI_SHOW_RAW_REASONING),
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
    modelKwargs: createModelKwargs(settings),
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
