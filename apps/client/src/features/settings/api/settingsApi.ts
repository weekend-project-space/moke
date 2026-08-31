import { apiFetch } from '../../../services/apiAccess'

export async function requestSettingsJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${apiBase}${path}`, init)
  const data = await response.json().catch(() => undefined) as unknown
  if (!response.ok) throw new Error(readSettingsApiError(data, response.status))
  return data as T
}

function readSettingsApiError(data: unknown, status: number) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const error = (data as Record<string, unknown>).error
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message) return message
    }
  }
  return `HTTP ${status}`
}
