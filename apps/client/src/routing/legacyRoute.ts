export function routeFromLegacyHash(hash: string) {
  if (!hash || hash.startsWith('#/')) return null
  if (hash === '#tasks') return '/tasks'
  const sessionId = new URLSearchParams(hash.slice(1)).get('session')
  return sessionId ? `/chat/${encodeURIComponent(sessionId)}` : null
}
