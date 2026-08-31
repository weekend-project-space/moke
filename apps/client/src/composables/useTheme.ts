import { ref } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'moke-theme'
const mode = ref<ThemeMode>(loadMode())
const systemDark = ref(false)
let mediaQuery: MediaQueryList | null = null

type NativeThemeWindow = {
  setTheme(theme?: 'light' | 'dark' | null): Promise<void>
}

const isMacOs = /Macintosh|Mac OS X/.test(navigator.userAgent) || navigator.platform.startsWith('Mac')

function syncNativeFrameColor(resolved: Exclude<ThemeMode, 'system'>) {
  requestAnimationFrame(() => {
    if (document.documentElement.dataset.theme !== resolved) return

    const color = getComputedStyle(document.documentElement).getPropertyValue('--color-bg-frame').trim()
    const invoke = window.__TAURI__?.core?.invoke
    if (!color || !invoke) return

    void invoke('plugin:window|set_background_color', { value: color }).catch((error) => {
      console.error('Could not sync the native window background', error)
    })
  })
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
  if (isMacOs) syncNativeFrameColor(resolved)
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
