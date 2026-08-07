export type BrowserSearchEngine = 'bing' | 'google' | 'baidu'

export type BrowserPreferences = {
  searchEngine: BrowserSearchEngine
}

export const BROWSER_PREFERENCES_KEY = 'moke.browser-settings.v1'

export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = {
  searchEngine: 'bing',
}

export function normalizeBrowserPreferences(input: Partial<BrowserPreferences> = {}): BrowserPreferences {
  return {
    searchEngine: input.searchEngine === 'google' || input.searchEngine === 'baidu'
      ? input.searchEngine
      : DEFAULT_BROWSER_PREFERENCES.searchEngine,
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
