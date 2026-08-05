export { default as BrowserPanel } from './components/BrowserPanel.vue'
export { useBrowserWorkspace } from './composables/useBrowserWorkspace'
export type { BrowserDataKind, BrowserLinkOpenMode } from './api/browser'
export {
  DEFAULT_BROWSER_PREFERENCES,
  loadBrowserPreferences,
  normalizeBrowserPreferences,
  saveBrowserPreferences,
  type BrowserPreferences,
  type BrowserSearchEngine,
} from './model/preferences'
