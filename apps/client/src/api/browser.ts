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

export type BrowserListResult = {
  pages: BrowserPage[]
  activePageId: number | null
}

type TauriGlobal = {
  core?: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
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
  listPages() {
    return tauriInvoke<BrowserListResult>('browser_list_pages')
  },

  createPage(options: { url?: string; visible?: boolean }) {
    return tauriInvoke<BrowserListResult>('browser_create_page', { options })
  },

  navigatePage(options: NavigateOptions) {
    return tauriInvoke<BrowserListResult>('browser_navigate_page', { options })
  },

  selectPage(pageId: number) {
    return tauriInvoke<BrowserListResult>('browser_select_page', { pageId })
  },

  closePage(pageId: number) {
    return tauriInvoke<BrowserListResult>('browser_close_page', { pageId })
  },

  resizePage(pageId: number | null, width?: number, height?: number) {
    return tauriInvoke<BrowserListResult>('browser_resize_page', {
      pageId: pageId ?? undefined,
      width,
      height,
    })
  },

  showBrowser(pageId?: number) {
    return tauriInvoke<BrowserListResult>('browser_show', { pageId })
  },

  hideBrowser(pageId?: number) {
    return tauriInvoke<BrowserListResult>('browser_hide', { pageId })
  },
}
