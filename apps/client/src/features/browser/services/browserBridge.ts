import { browserApi, isNativeBrowserAvailable, type BrowserBounds, type BrowserResult } from '../api/browser'
import { waitForBrowserLayoutFrame } from './browserLayout'
import { createSerialTaskQueue } from './serialTaskQueue'
import { apiFetch, apiUrl } from '../../../services/apiAccess'

type BrowserBridgeRequest = {
  id: string
  method: string
  params?: Record<string, unknown>
}

type BrowserBridgeOptions = {
  apiBase: string
  showBrowserPanel: () => void | Promise<void>
  getBrowserBounds?: () => BrowserBounds | null
}

type NavigateType = 'url' | 'back' | 'forward' | 'reload'

function readPageId(params: Record<string, unknown>) {
  return typeof params.pageId === 'number' ? params.pageId : undefined
}

function readBool(params: Record<string, unknown>, key: string) {
  return typeof params[key] === 'boolean' ? params[key] : undefined
}

function readString(params: Record<string, unknown>, key: string) {
  return typeof params[key] === 'string' ? params[key] as string : undefined
}

function readNumber(params: Record<string, unknown>, key: string) {
  return typeof params[key] === 'number' ? params[key] as number : undefined
}

async function revealBrowserPanel(options: BrowserBridgeOptions) {
  await options.showBrowserPanel()
  await waitForBrowserLayoutFrame()
  return options.getBrowserBounds?.() || undefined
}

async function executeAfterReveal<T>(
  options: BrowserBridgeOptions,
  action: (bounds: BrowserBounds | undefined) => Promise<T>,
) {
  return action(await revealBrowserPanel(options))
}

async function executeBrowserRequest(
  request: BrowserBridgeRequest,
  options: BrowserBridgeOptions,
): Promise<BrowserResult> {
  if (!isNativeBrowserAvailable()) throw new Error('Tauri browser API is not available')

  const params = request.params || {}

  switch (request.method) {
    case 'list_pages':
      return browserApi.state()
    case 'create_page': {
      return executeAfterReveal(options, (bounds) => browserApi.open({
        url: readString(params, 'url'),
        visible: readBool(params, 'visible') ?? true,
        bounds,
      }))
    }
    case 'select_page': {
      const pageId = readPageId(params)
      if (!pageId) throw new Error('pageId is required')
      return executeAfterReveal(options, (bounds) => browserApi.show(pageId, bounds))
    }
    case 'close_page': {
      const pageId = readPageId(params)
      if (!pageId) throw new Error('pageId is required')
      return browserApi.close(pageId)
    }
    case 'navigate_page': {
      const type = readString(params, 'type') as NavigateType | undefined
      if (!type) throw new Error('type is required')
      const pageId = readPageId(params)
      await executeAfterReveal(options, (bounds) => browserApi.show(pageId, bounds))
      return browserApi.navigate({
        pageId,
        type,
        url: readString(params, 'url'),
        ignoreCache: readBool(params, 'ignoreCache'),
      })
    }
    case 'evaluate_script':
      return executeAfterReveal(options, () => browserApi.evaluateScript(params))
    case 'take_snapshot':
      return browserApi.takeSnapshot(params)
    case 'take_screenshot':
      return executeAfterReveal(options, () => browserApi.takeScreenshot(params))
    case 'click':
      return executeAfterReveal(options, () => browserApi.click(params))
    case 'hover':
      return executeAfterReveal(options, () => browserApi.hover(params))
    case 'fill':
      return executeAfterReveal(options, () => browserApi.fill(params))
    case 'fill_form':
      return executeAfterReveal(options, () => browserApi.fillForm(params))
    case 'upload_file':
      return executeAfterReveal(options, () => browserApi.uploadFile(params))
    case 'wait_for':
      return browserApi.waitFor(params)
    case 'press_key':
      return executeAfterReveal(options, () => browserApi.pressKey(params))
    case 'type_text':
      return executeAfterReveal(options, () => browserApi.typeText(params))
    case 'handle_dialog':
      return browserApi.handleDialog(params)
    case 'resize_page': {
      const width = readNumber(params, 'width')
      const height = readNumber(params, 'height')
      if (!width || !height) throw new Error('width and height are required')
      return executeAfterReveal(options, () => browserApi.resizePage({
        pageId: readPageId(params),
        width,
        height,
      }))
    }
    case 'show_browser': {
      const bounds = await revealBrowserPanel(options)
      const state = await browserApi.state()
      if (!state.activePageId) return state
      return browserApi.show(state.activePageId, bounds)
    }
    case 'hide_browser':
      return browserApi.hide()
    default:
      throw new Error(`Unknown browser method: ${request.method}`)
  }
}

async function respond(apiBase: string, id: string, body: Record<string, unknown>) {
  await apiFetch(`${apiBase}/api/browser/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...body }),
  })
}

export function connectBrowserBridge(options: BrowserBridgeOptions) {
  if (!isNativeBrowserAvailable()) return () => undefined

  const source = new EventSource(apiUrl(`${options.apiBase}/api/browser/connect`))

  const execution = createSerialTaskQueue()

  source.addEventListener('browser_request', (message) => {
    const request = JSON.parse((message as MessageEvent).data) as BrowserBridgeRequest

    // Keep native webview operations ordered; otherwise late responses can overwrite newer state.
    void execution.enqueue(() => executeBrowserRequest(request, options)
      .then((result) => respond(options.apiBase, request.id, { ok: true, result }))
      .catch((error) => respond(options.apiBase, request.id, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })))
  })

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) source.close()
  }

  return () => source.close()
}
