import { isNativeBrowserAvailable } from '../api/browser'
import { connectBrowserBridge } from '../api/browserBridge'

type UseBrowserWorkspaceOptions = {
  apiBase: string
  openUrl?: (url: string) => Promise<void>
  openWorkspace: () => void
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

  async function openLinkInBrowser(rawUrl: string) {
    const url = normalizeHttpUrl(rawUrl)
    if (!url) return

    if (!isNativeBrowserAvailable()) {
      window.open(url, '_blank', 'noreferrer')
      return
    }

    options.openWorkspace()
    try {
      if (options.openUrl) {
        await options.openUrl(url)
      } else {
        window.open(url, '_blank', 'noreferrer')
      }
    } catch (error) {
      console.error('Failed to open link in browser', error)
      window.open(url, '_blank', 'noreferrer')
    }
  }

  function initBrowserWorkspace() {
    disconnectBrowserBridge = connectBrowserBridge({
      apiBase: options.apiBase,
      showBrowserPanel: options.openWorkspace,
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
