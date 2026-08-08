export type ActiveModelInfo = {
  model: string
  providerId: string
  providerName: string
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function activeModelFromSettings(value: unknown): ActiveModelInfo | null {
  const settings = toRecord(value)
  if (!settings || !Array.isArray(settings.providers)) return null

  const providers = settings.providers.map(toRecord).filter((provider) => provider !== null)
  const activeProviderId = typeof settings.activeProviderId === 'string' ? settings.activeProviderId : ''
  const provider = providers.find((item) => item.id === activeProviderId) || providers[0]
  if (!provider || typeof provider.model !== 'string' || !provider.model.trim()) return null

  return {
    model: provider.model.trim(),
    providerId: typeof provider.id === 'string' ? provider.id : '',
    providerName: typeof provider.name === 'string' ? provider.name.trim() : '',
  }
}
