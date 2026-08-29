import { ref } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'moke-theme'
const mode = ref<ThemeMode>(loadMode())
const systemDark = ref(false)
let mediaQuery: MediaQueryList | null = null

type NativeThemeWindow = {
  setTheme(theme?: 'light' | 'dark' | null): Promise<void>
  setBackgroundColor?(color: string): Promise<void>
}

const isMacOs = /Macintosh|Mac OS X/.test(navigator.userAgent) || navigator.platform.startsWith('Mac')

function nativeFrameColor() {
  const probe = document.createElement('span')
  probe.style.backgroundColor = 'var(--color-bg-frame)'
  document.documentElement.appendChild(probe)
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) return null
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
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
  if (isMacOs) {
    const frameColor = nativeFrameColor()
    if (frameColor) void nativeWindow?.setBackgroundColor?.(frameColor)?.catch(() => undefined)
  }
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
