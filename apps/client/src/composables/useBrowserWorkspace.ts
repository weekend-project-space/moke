import { browserApi, isNativeBrowserAvailable } from '../api/browser'
import { connectBrowserBridge } from '../api/browserBridge'

type UseBrowserWorkspaceOptions = {
  apiBase: string
  openWorkspace: () => void
}

export function useBrowserWorkspace(options: UseBrowserWorkspaceOptions) {
  let disconnectBrowserBridge: (() => void) | null = null

  async function openLinkInBrowser(rawUrl: string) {
    const url = rawUrl.trim()
    if (!url || url.startsWith('#')) return

    if (!isNativeBrowserAvailable()) {
      window.open(url, '_blank', 'noreferrer')
      return
    }

    options.openWorkspace()
    try {
      await browserApi.open({ url, visible: true })
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
