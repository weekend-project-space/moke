import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ChatModelSettings } from '../../../packages/agent-re-act/src/llm-client.js';

export type RuntimeSettings = {
  model: ChatModelSettings;
};

export type ModelSettingsInput = {
  apiKey?: unknown;
  apiBaseUrl?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
};

function defaultModelSettings(): ChatModelSettings {
  return {
    apiKey: process.env.OPENAI_API_KEY || '',
    apiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 15000),
  };
}

export function normalizeModelSettings(input: ModelSettingsInput = {}, fallback = defaultModelSettings()): ChatModelSettings {
  const timeoutMs = Number(input.timeoutMs);

  return {
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : fallback.apiKey,
    apiBaseUrl: typeof input.apiBaseUrl === 'string' && input.apiBaseUrl.trim() ? input.apiBaseUrl.trim() : fallback.apiBaseUrl,
    model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : fallback.model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : fallback.timeoutMs,
  };
}

export function createDefaultRuntimeSettings(): RuntimeSettings {
  return {
    model: defaultModelSettings(),
  };
}

export function loadRuntimeSettings(settingsPath: string): RuntimeSettings {
  const defaults = createDefaultRuntimeSettings();
  if (!existsSync(settingsPath)) return defaults;

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<RuntimeSettings>;
    return {
      model: normalizeModelSettings(parsed.model || {}, defaults.model),
    };
  } catch (error) {
    console.warn(`Failed to load settings from ${settingsPath}:`, error);
    return defaults;
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
