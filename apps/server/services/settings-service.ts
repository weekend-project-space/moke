import {
  loadRuntimeSettings,
  normalizeModelSettings,
  saveRuntimeSettings,
  type ModelSettingsInput,
  type RuntimeSettings,
} from '../storage/settings.js';

export class SettingsService {
  private readonly settings: RuntimeSettings;

  constructor(private readonly settingsPath: string) {
    this.settings = loadRuntimeSettings(settingsPath);
  }

  get() {
    return this.settings;
  }

  getModelSettings() {
    return this.settings.model;
  }

  updateModel(input: ModelSettingsInput) {
    this.settings.model = normalizeModelSettings(input, this.settings.model);
    saveRuntimeSettings(this.settingsPath, this.settings);
    return this.settings.model;
  }

  async testModel(input: ModelSettingsInput) {
    const settings = normalizeModelSettings(input, this.settings.model);
    const startedAt = Date.now();
    const result = await this.listModels(input);
    if (!result.ok) return { ...result, duration_ms: Date.now() - startedAt };

    const found = result.models.includes(settings.model);

    return {
      ok: found,
      stage: found ? 'done' : 'model',
      model: settings.model,
      model_count: result.models.length,
      message: found ? 'Model is available' : `Model "${settings.model}" was not found in /models`,
      duration_ms: Date.now() - startedAt,
    };
  }

  async listModels(input: ModelSettingsInput) {
    const settings = normalizeModelSettings(input, this.settings.model);
    const startedAt = Date.now();
    const result = await listModelSettings(settings);
    return {
      ...result,
      duration_ms: Date.now() - startedAt,
    };
  }
}

async function listModelSettings(settings: RuntimeSettings['model']) {
  if (!settings.apiKey) {
    return {
      ok: false,
      stage: 'auth',
      models: [],
      message: 'API Key is required',
    };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(settings.timeoutMs || 15000, 30000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${settings.apiBaseUrl.replace(/\/+$/, '')}/models`, {
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
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
