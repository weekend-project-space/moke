type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

let apiToken = ''
let initialization: Promise<void> | undefined

export async function initializeApiAccess() {
  if (initialization) return initialization
  initialization = initializeApiAccessInternal()
  return initialization
}

async function initializeApiAccessInternal() {
  const invoke = (window.__TAURI__ as { core?: { invoke?: TauriInvoke } } | undefined)?.core?.invoke
  if (!invoke) return

  const token = await invoke('agent_api_token')
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('Agent server token is unavailable')
  }
  apiToken = token
}

export function getApiToken() {
  return apiToken || undefined
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (apiToken) headers.set('Authorization', `Bearer ${apiToken}`)
  return initializeApiAccess().then(() => {
    if (apiToken) headers.set('Authorization', `Bearer ${apiToken}`)
    return fetch(input, { ...init, headers })
  })
}

export function apiUrl(input: string) {
  if (!apiToken) return input
  const url = new URL(input, window.location.href)
  url.searchParams.set('token', apiToken)
  return url.toString()
}
