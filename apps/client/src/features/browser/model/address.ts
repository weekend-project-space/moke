import type { BrowserSearchEngine } from './preferences'

const SEARCH_URLS: Record<BrowserSearchEngine, (query: string) => string> = {
  baidu: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
}

function looksLikeHost(value: string) {
  if (/\s/.test(value)) return false
  const host = value.split(/[/?#]/, 1)[0]?.replace(/:\d+$/, '') || ''
  if (host === 'localhost' || /^\[[0-9a-f:]+\]$/i.test(host)) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true
  return host.includes('.') && !host.startsWith('.') && !host.endsWith('.')
}

export function resolveBrowserAddress(value: string, searchEngine: BrowserSearchEngine) {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  if (trimmed === 'about:blank' || /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
  if (looksLikeHost(trimmed)) return `https://${trimmed}`
  return SEARCH_URLS[searchEngine](trimmed)
}

export function formatBrowserAddressHost(value: string) {
  if (!value || value === 'about:blank') return ''

  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : value
  } catch {
    return value
  }
}
