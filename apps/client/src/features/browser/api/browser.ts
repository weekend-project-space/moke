export type BrowserPage = {
  pageId: number
  label: string
  url: string
  title: string
  faviconUrl: string
  faviconUrls: string[]
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  visible: boolean
}

export type BrowserResult = {
  page: BrowserPage | null
  pages: BrowserPage[]
  activePageId: number | null
  snapshot?: BrowserSnapshot
  value?: unknown
  matched?: string
}

export type BrowserStateChange = {
  eventType: string
  pageId?: number
  state: BrowserResult
}

export type BrowserSnapshotNode = {
  uid: string
  role: string
  name: string
  tag: string
  text?: string
  value?: string
  href?: string
  disabled?: boolean
  visible?: boolean
  children?: BrowserSnapshotNode[]
}

export type BrowserSnapshotContent = {
  markdown: string
  truncated: boolean
}

export type BrowserSnapshot = {
  url: string
  title: string
  content: BrowserSnapshotContent
  elements: BrowserSnapshotNode[]
}

export type BrowserDialogResult = {
  handled: boolean
}

export type BrowserDownloadChange = {
  url: string
  path?: string | null
  fileName: string
  status: 'downloading' | 'completed' | 'failed'
}

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserLinkOpenMode = 'current' | 'new-tab'
export type BrowserDataKind = 'cache' | 'cookies'

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

type BrowserAutomationOptions = Record<string, unknown>

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
  listenStateChanged(handler: (change: BrowserStateChange) => void) {
    const listen = window.__TAURI__?.event?.listen
    if (!listen) return Promise.resolve(() => undefined)

    return listen<BrowserStateChange>('browser_state_change', (event) => handler(event.payload))
  },

  listenDownloadChanges(handler: (change: BrowserDownloadChange) => void) {
    const listen = window.__TAURI__?.event?.listen
    if (!listen) return Promise.resolve(() => undefined)

    return listen<BrowserDownloadChange>('browser_download_change', (event) => handler(event.payload))
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

  evaluateScript(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_evaluate_script', { options })
  },

  takeSnapshot(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_take_snapshot', { options })
  },

  takeScreenshot(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_take_screenshot', { options })
  },

  capturePreview(pageId: number) {
    return tauriInvoke<string>('browser_capture_preview', { pageId })
  },

  openDownload(path: string, reveal = false) {
    return tauriInvoke<void>('browser_open_download', { path, reveal })
  },

  click(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_click', { options })
  },

  hover(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_hover', { options })
  },

  fill(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_fill', { options })
  },

  fillForm(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_fill_form', { options })
  },

  uploadFile(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_upload_file', { options })
  },

  waitFor(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_wait_for', { options })
  },

  pressKey(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_press_key', { options })
  },

  typeText(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_type_text', { options })
  },

  handleDialog(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('browser_handle_dialog', { options })
  },

  resizePage(options: BrowserAutomationOptions) {
    return tauriInvoke<BrowserResult>('resize_page', options)
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

  select(pageId: number) {
    return tauriInvoke<BrowserResult>('select_page', { pageId })
  },

  hide() {
    return tauriInvoke<BrowserResult>('browser_hide')
  },

  close(pageId: number) {
    return tauriInvoke<BrowserResult>('browser_close', { pageId })
  },

  clearBrowsingData(kind: BrowserDataKind) {
    return tauriInvoke<void>('browser_clear_data', { kind })
  },
}
