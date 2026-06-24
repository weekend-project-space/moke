export type BrowserPage = {
  pageId: number
  label: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  visible: boolean
}

export type BrowserResult = {
  page: BrowserPage | null
  pages: BrowserPage[]
  activePageId: number | null
}

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

type TauriGlobal = {
  core?: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  }
  event?: {
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>
  }
}

type NavigateOptions = {
  pageId?: number
  type: 'url' | 'back' | 'forward' | 'reload'
  url?: string
  ignoreCache?: boolean
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal
  }
}

function tauriInvoke<T>(command: string, args?: Record<string, unknown>) {
  const invoke = window.__TAURI__?.core?.invoke
  if (!invoke) throw new Error('Tauri API is not available')

  return invoke<T>(command, args)
}

export function isNativeBrowserAvailable() {
  return Boolean(window.__TAURI__?.core?.invoke)
}

export const browserApi = {
  listenStateChanged(handler: (result: BrowserResult) => void) {
    const listen = window.__TAURI__?.event?.listen
    if (!listen) return Promise.resolve(() => undefined)

    return listen<BrowserResult>('browser_state_changed', (event) => handler(event.payload))
  },

  state() {
    return tauriInvoke<BrowserResult>('browser_state')
  },

  refreshState(pageId?: number) {
    return tauriInvoke<BrowserResult>('browser_refresh_state', { pageId })
  },

  open(options: { pageId?: number; url?: string; visible?: boolean; bounds?: BrowserBounds }) {
    return tauriInvoke<BrowserResult>('browser_open', { options })
  },

  navigate(options: NavigateOptions) {
    return tauriInvoke<BrowserResult>('browser_navigate', { options })
  },

  resize(pageId: number | null, bounds: BrowserBounds) {
    return tauriInvoke<void>('browser_resize', {
      pageId: pageId ?? undefined,
      ...bounds,
    })
  },

  show(pageId?: number, bounds?: BrowserBounds) {
    return tauriInvoke<BrowserResult>('browser_show', { pageId, bounds })
  },

  hide() {
    return tauriInvoke<BrowserResult>('browser_hide')
  },

  close(pageId: number) {
    return tauriInvoke<BrowserResult>('browser_close', { pageId })
  },
}
