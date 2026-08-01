const SESSION_HASH_KEY = 'session'

export function readSessionIdFromHash() {
  const params = new URLSearchParams(window.location.hash.slice(1))
  return params.get(SESSION_HASH_KEY) || ''
}

export function writeSessionIdToHash(id: string) {
  const nextHash = id ? new URLSearchParams({ [SESSION_HASH_KEY]: id }).toString() : ''
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
}
