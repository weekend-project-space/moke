import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';
export type ReasoningProvider = 'none' | 'llama.cpp';

export type ChatModelSettings = {
  apiKey: string;
  apiBaseUrl: string;
  maxRetries: number;
  model: string;
  type: ModelProviderType;
  reasoningEffort: ReasoningEffort;
  reasoningProvider: ReasoningProvider;
  showRawReasoning: boolean;
  timeoutMs: number;
};

export type ModelProviderType = 'openai-compatible' | 'openai-responses';

export type ModelProviderProfile = {
  id: string;
  name: string;
  type: ModelProviderType;
  apiKey: string;
  apiBaseUrl: string;
  maxRetries: number;
  model: string;
  models: ProviderModel[];
  defaultModel: string;
  reasoningEffort: ReasoningEffort;
  reasoningProvider: ReasoningProvider;
  showRawReasoning: boolean;
  timeoutMs: number;
};

export type ProviderModel = {
  name: string;
  alias: string;
};

export type RuntimeSettings = {
  activeProviderId: string;
  providers: ModelProviderProfile[];
};

export type ModelProviderInput = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  apiKey?: unknown;
  apiBaseUrl?: unknown;
  maxRetries?: unknown;
  model?: unknown;
  models?: unknown;
  defaultModel?: unknown;
  reasoningEffort?: unknown;
  reasoningProvider?: unknown;
  showRawReasoning?: unknown;
  timeoutMs?: unknown;
};

export type RuntimeSettingsInput = {
  activeProviderId?: unknown;
  providers?: unknown;
};

export const MODEL_PROVIDER_TIMEOUT_MIN_MS = 1000;
export const MODEL_PROVIDER_TIMEOUT_MAX_MS = 60 * 60 * 1000;
export const MODEL_PROVIDER_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000;
export const MODEL_PROVIDER_MAX_RETRIES_MIN = 0;
export const MODEL_PROVIDER_MAX_RETRIES_MAX = 6;
export const MODEL_PROVIDER_MAX_RETRIES_DEFAULT = 3;
export const MODEL_PROVIDER_REASONING_EFFORT_DEFAULT: ReasoningEffort = 'medium';
export const MODEL_PROVIDER_REASONING_PROVIDER_DEFAULT: ReasoningProvider = 'none';
export const MODEL_PROVIDER_SHOW_RAW_REASONING_DEFAULT = false;
export const MODEL_PROVIDER_DEFAULT_NAME = 'Local Qwen';
export const MODEL_PROVIDER_DEFAULT_API_KEY = 'test';
export const MODEL_PROVIDER_DEFAULT_BASE_URL = 'http://localhost:8080/v1';
export const MODEL_PROVIDER_DEFAULT_MODEL = 'qwen3.6-35BA3B';

export function createProviderId() {
  return `provider_${randomUUID().slice(0, 8)}`;
}

export function normalizeProviderTimeoutMs(input: unknown, fallback = MODEL_PROVIDER_TIMEOUT_DEFAULT_MS) {
  const timeoutMs = Number(input);
  const normalized = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : fallback;
  return Math.max(MODEL_PROVIDER_TIMEOUT_MIN_MS, Math.min(normalized, MODEL_PROVIDER_TIMEOUT_MAX_MS));
}

export function normalizeProviderMaxRetries(input: unknown, fallback = MODEL_PROVIDER_MAX_RETRIES_DEFAULT) {
  const maxRetries = Number(input);
  const normalized = Number.isFinite(maxRetries) ? Math.trunc(maxRetries) : fallback;
  return Math.max(MODEL_PROVIDER_MAX_RETRIES_MIN, Math.min(normalized, MODEL_PROVIDER_MAX_RETRIES_MAX));
}

export function normalizeProviderReasoningEffort(
  input: unknown,
  fallback = MODEL_PROVIDER_REASONING_EFFORT_DEFAULT,
): ReasoningEffort {
  if (input === 'ultra') return 'max';
  return input === 'off' || input === 'low' || input === 'medium' || input === 'high' || input === 'max'
    ? input
    : fallback;
}

export function normalizeProviderReasoningProvider(
  input: unknown,
  fallback = MODEL_PROVIDER_REASONING_PROVIDER_DEFAULT,
): ReasoningProvider {
  return input === 'llama.cpp' ? input : fallback;
}

export function normalizeProviderShowRawReasoning(
  input: unknown,
  fallback = MODEL_PROVIDER_SHOW_RAW_REASONING_DEFAULT,
) {
  if (typeof input === 'boolean') return input;
  if (input === 'true') return true;
  if (input === 'false') return false;
  return fallback;
}

export function normalizeProviderType(input: unknown, fallback: ModelProviderType = 'openai-compatible'): ModelProviderType {
  return input === 'openai-compatible' || input === 'openai-responses' ? input : fallback;
}

function normalizeProviderModels(input: unknown, legacyModel: string): ProviderModel[] {
  const raw = Array.isArray(input) ? input : [];
  const models = raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const value = item as Record<string, unknown>;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name) return null;
    return { name, alias: typeof value.alias === 'string' ? value.alias.trim() : '' };
  }).filter((item): item is ProviderModel => Boolean(item?.name));
  if (models.length) return models.filter((model, index) => models.findIndex((candidate) => candidate.name === model.name) === index);
  return legacyModel ? [{ name: legacyModel, alias: '' }] : [];
}

function defaultProvider(): ModelProviderProfile {
  const model = process.env.OPENAI_MODEL || MODEL_PROVIDER_DEFAULT_MODEL;
  const reasoningProvider = normalizeProviderReasoningProvider(process.env.OPENAI_REASONING_PROVIDER);
  return {
    id: createProviderId(),
    name: process.env.OPENAI_PROVIDER_NAME || MODEL_PROVIDER_DEFAULT_NAME,
    type: 'openai-compatible',
    apiKey: process.env.OPENAI_API_KEY || MODEL_PROVIDER_DEFAULT_API_KEY,
    apiBaseUrl: process.env.OPENAI_BASE_URL || MODEL_PROVIDER_DEFAULT_BASE_URL,
    maxRetries: normalizeProviderMaxRetries(process.env.OPENAI_MAX_RETRIES),
    model,
    models: [{ name: model, alias: '' }],
    defaultModel: model,
    reasoningEffort: normalizeProviderReasoningEffort(process.env.OPENAI_REASONING_EFFORT),
    reasoningProvider,
    showRawReasoning: normalizeProviderShowRawReasoning(process.env.OPENAI_SHOW_RAW_REASONING),
    timeoutMs: normalizeProviderTimeoutMs(process.env.OPENAI_TIMEOUT_MS),
  };
}

export function providerToModelSettings(provider: ModelProviderProfile): ChatModelSettings {
  return {
    apiKey: provider.apiKey,
    apiBaseUrl: provider.apiBaseUrl,
    maxRetries: provider.maxRetries,
    model: provider.defaultModel || provider.model,
    type: provider.type,
    reasoningEffort: provider.reasoningEffort,
    reasoningProvider: provider.reasoningProvider,
    showRawReasoning: provider.showRawReasoning,
    timeoutMs: provider.timeoutMs,
  };
}

export function normalizeProvider(input: ModelProviderInput = {}, fallback = defaultProvider()): ModelProviderProfile {
  const type = normalizeProviderType(input.type, fallback.type);
  const reasoningProvider = normalizeProviderReasoningProvider(input.reasoningProvider, fallback.reasoningProvider);
  const legacyModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : fallback.model;
  const models = normalizeProviderModels(input.models, legacyModel);
  const requestedDefault = typeof input.defaultModel === 'string' ? input.defaultModel.trim() : '';
  const defaultModel = models.some((item) => item.name === requestedDefault) ? requestedDefault : (models[0]?.name || legacyModel);

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : fallback.id || createProviderId(),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : fallback.name,
    type,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : fallback.apiKey,
    apiBaseUrl: typeof input.apiBaseUrl === 'string' && input.apiBaseUrl.trim() ? input.apiBaseUrl.trim() : fallback.apiBaseUrl,
    maxRetries: normalizeProviderMaxRetries(input.maxRetries, fallback.maxRetries),
    model: defaultModel,
    models,
    defaultModel,
    reasoningEffort: normalizeProviderReasoningEffort(input.reasoningEffort, fallback.reasoningEffort),
    reasoningProvider,
    showRawReasoning: normalizeProviderShowRawReasoning(input.showRawReasoning, fallback.showRawReasoning),
    timeoutMs: normalizeProviderTimeoutMs(input.timeoutMs, fallback.timeoutMs),
  };
}

export function createDefaultRuntimeSettings(): RuntimeSettings {
  const provider = defaultProvider();
  return {
    activeProviderId: provider.id,
    providers: [provider],
  };
}

export function normalizeRuntimeSettings(input: RuntimeSettingsInput = {}): RuntimeSettings {
  const defaults = createDefaultRuntimeSettings();
  const rawProviders = Array.isArray(input.providers) ? input.providers : [];
  const providers = rawProviders
    .map((provider, index) => normalizeProvider(provider as ModelProviderInput, index === 0 ? defaults.providers[0] : defaultProvider()))
    .filter((provider) => provider.id);
  const normalizedProviders = providers.length > 0 ? providers : defaults.providers;
  const activeProviderId =
    typeof input.activeProviderId === 'string' &&
    normalizedProviders.some((provider) => provider.id === input.activeProviderId)
      ? input.activeProviderId
      : normalizedProviders[0].id;

  return {
    activeProviderId,
    providers: normalizedProviders,
  };
}

export function loadRuntimeSettings(settingsPath: string): RuntimeSettings {
  if (!existsSync(settingsPath)) return createDefaultRuntimeSettings();

  try {
    return normalizeRuntimeSettings(JSON.parse(readFileSync(settingsPath, 'utf8')) as RuntimeSettingsInput);
  } catch (error) {
    console.warn(`Failed to load settings from ${settingsPath}:`, error);
    return createDefaultRuntimeSettings();
  }
}

export function saveRuntimeSettings(settingsPath: string, settings: RuntimeSettings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, settingsPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw new Error(`Failed to save settings to ${settingsPath}`, { cause: error });
  }
}
