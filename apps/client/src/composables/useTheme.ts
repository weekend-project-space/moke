import { ref } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'moke-theme'
const mode = ref<ThemeMode>(loadMode())
const systemDark = ref(false)
let mediaQuery: MediaQueryList | null = null

type NativeThemeWindow = {
  setTheme(theme?: 'light' | 'dark' | null): Promise<void>
}

function loadMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system'

  const value = window.localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function updateSystemPreference() {
  systemDark.value = Boolean(mediaQuery?.matches)
  applyTheme()
}

function applyTheme() {
  if (typeof window === 'undefined') return

  const resolved = mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  const nativeWindow = (window.__TAURI__ as {
    window?: { getCurrentWindow(): NativeThemeWindow }
  } | undefined)?.window?.getCurrentWindow()
  void nativeWindow?.setTheme(mode.value === 'system' ? null : resolved).catch(() => undefined)
}

function initializeTheme() {
  if (typeof window === 'undefined') return

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
