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

export class SettingsService {
  private settings: RuntimeSettings;

  constructor(private readonly settingsPath: string) {
    this.settings = loadRuntimeSettings(settingsPath);
  }

  get() {
    return {
      activeProviderId: this.settings.activeProviderId,
      providers: this.settings.providers.map((provider) => ({ ...provider })),
    };
  }

  getModelSettings() {
    const provider =
      this.settings.providers.find((item) => item.id === this.settings.activeProviderId) || this.settings.providers[0];
    return providerToModelSettings(provider);
  }

  updateModelProviders(input: RuntimeSettingsInput) {
    this.settings = normalizeRuntimeSettings(input);
    saveRuntimeSettings(this.settingsPath, this.settings);
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

async function listProviderModels(provider: ReturnType<typeof normalizeProvider>) {
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
