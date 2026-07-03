import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ChatModelSettings } from '../../../packages/agent-re-act/src/llm-client.js';

export type ModelProviderType = 'openai-compatible';

export type ModelProviderProfile = {
  id: string;
  name: string;
  type: ModelProviderType;
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  timeoutMs: number;
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
  model?: unknown;
  timeoutMs?: unknown;
};

export type RuntimeSettingsInput = {
  activeProviderId?: unknown;
  providers?: unknown;
};

export function createProviderId() {
  return `provider_${randomUUID().slice(0, 8)}`;
}

function defaultProvider(): ModelProviderProfile {
  return {
    id: createProviderId(),
    name: process.env.OPENAI_PROVIDER_NAME || 'OpenAI',
    type: 'openai-compatible',
    apiKey: process.env.OPENAI_API_KEY || '',
    apiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 15000),
  };
}

export function providerToModelSettings(provider: ModelProviderProfile): ChatModelSettings {
  return {
    apiKey: provider.apiKey,
    apiBaseUrl: provider.apiBaseUrl,
    model: provider.model,
    timeoutMs: provider.timeoutMs,
  };
}

export function normalizeProvider(input: ModelProviderInput = {}, fallback = defaultProvider()): ModelProviderProfile {
  const timeoutMs = Number(input.timeoutMs);
  const type = input.type === 'openai-compatible' ? input.type : fallback.type;

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : fallback.id || createProviderId(),
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : fallback.name,
    type,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : fallback.apiKey,
    apiBaseUrl: typeof input.apiBaseUrl === 'string' && input.apiBaseUrl.trim() ? input.apiBaseUrl.trim() : fallback.apiBaseUrl,
    model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : fallback.model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : fallback.timeoutMs,
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
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (error) {
    console.warn(`Failed to save settings to ${settingsPath}:`, error);
  }
}
