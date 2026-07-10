const SESSION_HASH_KEY = 'session'

export function readSessionIdFromHash() {
  const params = new URLSearchParams(window.location.hash.slice(1))
  return params.get(SESSION_HASH_KEY) || ''
}

export function writeSessionIdToHash(id: string) {
  const params = new URLSearchParams(window.location.hash.slice(1))
  if (id) {
    params.set(SESSION_HASH_KEY, id)
  } else {
    params.delete(SESSION_HASH_KEY)
  }

  const nextHash = params.toString()
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
}
