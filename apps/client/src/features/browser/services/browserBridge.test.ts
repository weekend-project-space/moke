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
      requestAnimationFrame(callback: FrameRequestCallback) {
        callback(0)
        return 1
      },
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

test('new_tab stays in the background regardless of visible input', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const events: string[] = []
  const restoreWindow = installTauriInvoke(calls)

  try {
    await executeBrowserRequest(
      { id: 'request-1', method: 'new_tab', params: { url: 'https://example.com', visible: true } },
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

test('background browser tools do not open the browser panel', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const events: string[] = []
  const restoreWindow = installTauriInvoke(calls)
  const requests = [
    { method: 'list_tabs' },
    { method: 'switch_tab', params: { pageId: 1 } },
    { method: 'close_tab', params: { pageId: 1 } },
    { method: 'navigate', params: { pageId: 1, type: 'reload' } },
    { method: 'evaluate', params: { pageId: 1, function: '() => 1' } },
    { method: 'snapshot', params: { pageId: 1 } },
    { method: 'screenshot', params: { pageId: 1 } },
    { method: 'click', params: { pageId: 1, uid: 'e1' } },
    { method: 'hover', params: { pageId: 1, uid: 'e1' } },
    { method: 'fill', params: { pageId: 1, uid: 'e1', value: 'text' } },
    { method: 'fill_form', params: { pageId: 1, elements: [{ uid: 'e1', value: 'text' }] } },
    { method: 'upload_file', params: { pageId: 1, uid: 'e1', filePath: 'file.txt' } },
    { method: 'wait_for_text', params: { pageId: 1, text: 'ready' } },
    { method: 'press', params: { pageId: 1, key: 'Enter' } },
    { method: 'type', params: { pageId: 1, text: 'text' } },
    { method: 'handle_dialog', params: { pageId: 1, action: 'dismiss' } },
    { method: 'resize_viewport', params: { pageId: 1, width: 800, height: 600 } },
  ]

  try {
    for (const request of requests) {
      await executeBrowserRequest({ id: request.method, ...request }, createOptions(events))
    }
    assert.deepEqual(events, [])
    assert.deepEqual(calls.map((call) => call.command), [
      'browser_state', 'select_page', 'browser_close', 'browser_navigate',
      'browser_evaluate_script', 'browser_take_snapshot', 'browser_take_screenshot',
      'browser_click', 'browser_hover', 'browser_fill', 'browser_fill_form',
      'browser_upload_file', 'browser_wait_for', 'browser_press_key',
      'browser_type_text', 'browser_handle_dialog', 'resize_page',
    ])
  } finally {
    restoreWindow()
  }
})

test('show_browser is the only browser tool that opens the browser panel', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const events: string[] = []
  const restoreWindow = installTauriInvoke(calls)

  try {
    await executeBrowserRequest({ id: 'request-show', method: 'show_browser' }, createOptions(events))
    assert.deepEqual(events, ['show-panel'])
  } finally {
    restoreWindow()
  }
})
