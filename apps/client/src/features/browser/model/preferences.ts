export type BrowserLinkOpenMode = 'current' | 'new-tab'

export type BrowserPreferences = {
  browserHomeUrl: string
  linkOpenMode: BrowserLinkOpenMode
}

export const BROWSER_PREFERENCES_KEY = 'moke.browser-settings.v1'

export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = {
  browserHomeUrl: 'https://www.baidu.com/',
  linkOpenMode: 'current',
}

export function normalizeBrowserPreferences(input: Partial<BrowserPreferences> = {}): BrowserPreferences {
  return {
    ...DEFAULT_BROWSER_PREFERENCES,
    ...input,
    linkOpenMode: input.linkOpenMode === 'new-tab' ? 'new-tab' : 'current',
  }
}

export function loadBrowserPreferences(): BrowserPreferences {
  try {
    const stored = JSON.parse(window.localStorage.getItem(BROWSER_PREFERENCES_KEY) || '{}') as Partial<BrowserPreferences>
    return normalizeBrowserPreferences(stored)
  } catch {
    return { ...DEFAULT_BROWSER_PREFERENCES }
  }
}

export function saveBrowserPreferences(preferences: BrowserPreferences) {
  window.localStorage.setItem(BROWSER_PREFERENCES_KEY, JSON.stringify(preferences))
}
