import type { ModelSelection } from '@moke/protocol';

import {
  loadRuntimeSettings,
  normalizeProvider,
  normalizeProviderTimeoutMs,
  normalizeRuntimeSettings,
  providerToModelSettings,
  saveRuntimeSettings,
  type ModelProviderInput,
  type RuntimeSettings,
  type RuntimeSettingsInput,
} from '../storage/settings.js';

export class ModelProviderNotFoundError extends Error {
  readonly code = 'MODEL_PROVIDER_NOT_FOUND';

  constructor(readonly providerId: string) {
    super(`Model provider "${providerId}" was not found`);
    this.name = 'ModelProviderNotFoundError';
  }
}

export class SettingsService {
  private settings: RuntimeSettings;

  constructor(private readonly settingsPath: string) {
    this.settings = loadRuntimeSettings(settingsPath);
  }

  get() {
    const activeProvider =
      this.settings.providers.find((item) => item.id === this.settings.activeProviderId) || this.settings.providers[0];

    return {
      activeProviderId: this.settings.activeProviderId,
      providers: this.settings.providers.map((provider) => ({ ...provider })),
      reasoningCapability: {
        efforts: ['off', 'low', 'medium', 'high', 'max'],
        rawSupported: activeProvider?.reasoningProvider === 'llama.cpp',
        supported: activeProvider?.reasoningProvider === 'llama.cpp' || activeProvider?.type === 'openai-responses',
      },
    };
  }

  resolveModelSelection(selection?: ModelSelection): ModelSelection {
    const provider = selection
      ? this.settings.providers.find((item) => item.id === selection.provider_id)
      : this.settings.providers.find((item) => item.id === this.settings.activeProviderId) || this.settings.providers[0];
    if (!provider) throw new ModelProviderNotFoundError(selection?.provider_id || this.settings.activeProviderId);
    return {
      provider_id: provider.id,
      name: selection?.name?.trim() || provider.model,
    };
  }

  getModelSettings(selection?: ModelSelection) {
    const resolved = this.resolveModelSelection(selection);
    const provider = this.settings.providers.find((item) => item.id === resolved.provider_id);
    if (!provider) throw new ModelProviderNotFoundError(resolved.provider_id);
    return {
      ...providerToModelSettings(provider),
      model: resolved.name || provider.model,
    };
  }

  updateModelProviders(input: RuntimeSettingsInput) {
    const nextSettings = normalizeRuntimeSettings(input);
    saveRuntimeSettings(this.settingsPath, nextSettings);
    this.settings = nextSettings;
    return this.get();
  }

  async testModel(input: ModelProviderInput) {
    const provider = normalizeProvider(input);
    const startedAt = Date.now();
    const result = await this.listModels(input);
    if (!result.ok) return { ...result, duration_ms: Date.now() - startedAt };

    const found = result.models.includes(provider.model);

    return {
      ok: found,
      stage: found ? 'done' : 'model',
      model: provider.model,
      model_count: result.models.length,
      message: found ? 'Model is available' : `Model "${provider.model}" was not found in /models`,
      duration_ms: Date.now() - startedAt,
    };
  }

  async listModels(input: ModelProviderInput) {
    const provider = normalizeProvider(input);
    const startedAt = Date.now();
    const result = await listProviderModels(provider);
    return {
      ...result,
      duration_ms: Date.now() - startedAt,
    };
  }
}

type ListProviderModelsResult = {
  ok: boolean;
  stage: 'auth' | 'models' | 'network';
  models: string[];
  message: string;
  status?: number;
  model_count?: number;
};

async function listProviderModels(provider: ReturnType<typeof normalizeProvider>): Promise<ListProviderModelsResult> {
  if (!provider.apiKey) {
    return {
      ok: false,
      stage: 'auth',
      models: [],
      message: 'API Key is required',
    };
  }

  const controller = new AbortController();
  const timeoutMs = normalizeProviderTimeoutMs(provider.timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${provider.apiBaseUrl.replace(/\/+$/, '')}/models`, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        stage: response.status === 401 || response.status === 403 ? 'auth' : 'models',
        status: response.status,
        models: [],
        message: await readErrorMessage(response),
      };
    }

    const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const modelIds = Array.isArray(data.data)
      ? data.data.map((item) => (typeof item.id === 'string' ? item.id : '')).filter(Boolean)
      : [];

    return {
      ok: true,
      stage: 'models',
      models: modelIds,
      model_count: modelIds.length,
      message: modelIds.length > 0 ? 'Models loaded' : 'No models returned',
    };
  } catch (error) {
    return {
      ok: false,
      stage: 'network',
      models: [],
      message: error instanceof Error && error.name === 'AbortError'
        ? `Request timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : 'Unable to test model',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as { error?: { message?: unknown }; message?: unknown };
    const message = data.error?.message || data.message;
    return typeof message === 'string' && message.trim() ? message.trim() : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
