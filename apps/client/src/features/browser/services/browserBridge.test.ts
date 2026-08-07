import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserRequest, type BrowserBridgeOptions } from './browserBridge'

const emptyBrowserState = {
  page: null,
  pages: [],
  activePageId: null,
}

function installTauriInvoke(calls: Array<{ command: string; args?: Record<string, unknown> }>) {
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI__: {
        core: {
          async invoke(command: string, args?: Record<string, unknown>) {
            calls.push({ command, args })
            return emptyBrowserState
          },
        },
      },
    },
  })

  return () => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
}

function createOptions(events: string[]): BrowserBridgeOptions {
  return {
    apiBase: '',
    showBrowserPanel: () => events.push('show-panel'),
    hideBrowserPanel: () => events.push('hide-panel'),
  }
}

test('create_page with visible false stays in the background', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const events: string[] = []
  const restoreWindow = installTauriInvoke(calls)

  try {
    await executeBrowserRequest(
      { id: 'request-1', method: 'create_page', params: { url: 'https://example.com', visible: false } },
      createOptions(events),
    )

    assert.deepEqual(events, [])
    assert.deepEqual(calls, [{
      command: 'browser_open',
      args: { options: { url: 'https://example.com', visible: false } },
    }])
  } finally {
    restoreWindow()
  }
})

test('hide_browser hides the native page and collapses the browser panel', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const events: string[] = []
  const restoreWindow = installTauriInvoke(calls)

  try {
    await executeBrowserRequest(
      { id: 'request-2', method: 'hide_browser' },
      createOptions(events),
    )

    assert.deepEqual(calls, [{ command: 'browser_hide', args: undefined }])
    assert.deepEqual(events, ['hide-panel'])
  } finally {
    restoreWindow()
  }
})
