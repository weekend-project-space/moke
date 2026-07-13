export { default as BrowserPanel } from './components/BrowserPanel.vue'
export { useBrowserWorkspace } from './composables/useBrowserWorkspace'
export {
  DEFAULT_BROWSER_PREFERENCES,
  loadBrowserPreferences,
  normalizeBrowserPreferences,
  saveBrowserPreferences,
  type BrowserLinkOpenMode,
  type BrowserPreferences,
} from './model/preferences'
