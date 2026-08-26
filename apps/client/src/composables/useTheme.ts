import { ref } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'moke-theme'
const mode = ref<ThemeMode>(loadMode())
const systemDark = ref(false)
let mediaQuery: MediaQueryList | null = null

function loadMode(): ThemeMode {
  const value = localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function updateSystemPreference() {
  systemDark.value = Boolean(mediaQuery?.matches)
  applyTheme()
}

function applyTheme() {
  const resolved = mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}

function initializeTheme() {
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  updateSystemPreference()
  mediaQuery.addEventListener('change', updateSystemPreference)
}

function setTheme(nextMode: ThemeMode) {
  mode.value = nextMode
  localStorage.setItem(STORAGE_KEY, nextMode)
  applyTheme()
}

export function useTheme() {
  return { mode, setTheme, initializeTheme }
}
