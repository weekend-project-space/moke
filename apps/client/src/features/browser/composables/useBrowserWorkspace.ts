import { isNativeBrowserAvailable, type BrowserBounds, type BrowserLinkOpenMode } from '../api/browser'
import { connectBrowserBridge } from '../services/browserBridge'
import { initializeApiAccess } from '../../../services/apiAccess'

type UseBrowserWorkspaceOptions = {
  apiBase: string
  getBrowserBounds?: () => BrowserBounds | null
  openUrl?: (url: string, mode: BrowserLinkOpenMode) => Promise<void>
  openWorkspace: () => void
  closeWorkspace: () => void
}

export function useBrowserWorkspace(options: UseBrowserWorkspaceOptions) {
  let disconnectBrowserBridge: (() => void) | null = null

  function normalizeHttpUrl(rawUrl: string) {
    const trimmed = rawUrl.trim()
    if (!trimmed || trimmed.startsWith('#')) return null

    try {
      const url = new URL(trimmed, window.location.href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      return url.toString()
    } catch {
      return null
    }
  }

  async function openLinkInBrowser(rawUrl: string, mode: BrowserLinkOpenMode = 'current') {
    const url = normalizeHttpUrl(rawUrl)
    if (!url) return

    if (!isNativeBrowserAvailable()) {
      window.open(url, '_blank', 'noreferrer')
      return
    }

    options.openWorkspace()
    try {
      if (options.openUrl) {
        await options.openUrl(url, mode)
      } else {
        window.open(url, '_blank', 'noreferrer')
      }
    } catch (error) {
      console.error('Failed to open link in browser', error)
      window.open(url, '_blank', 'noreferrer')
    }
  }

  async function initBrowserWorkspace() {
    if (!isNativeBrowserAvailable()) return

    try {
      await initializeApiAccess()
    } catch (error) {
      console.error('Failed to initialize browser bridge authentication', error)
      return
    }

    disconnectBrowserBridge = connectBrowserBridge({
      apiBase: options.apiBase,
      getBrowserBounds: options.getBrowserBounds,
      showBrowserPanel: options.openWorkspace,
      hideBrowserPanel: options.closeWorkspace,
    })
  }

  function disposeBrowserWorkspace() {
    disconnectBrowserBridge?.()
    disconnectBrowserBridge = null
  }

  return {
    disposeBrowserWorkspace,
    initBrowserWorkspace,
    openLinkInBrowser,
  }
}
