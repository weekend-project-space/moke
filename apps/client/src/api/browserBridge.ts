import { browserApi, isNativeBrowserAvailable, type BrowserBounds, type BrowserResult } from './browser'

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

function waitForLayoutFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

async function revealBrowserPanel(options: BrowserBridgeOptions) {
  await options.showBrowserPanel()
  await waitForLayoutFrame()
  return options.getBrowserBounds?.() || undefined
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
      const bounds = await revealBrowserPanel(options)
      return browserApi.open({
        url: readString(params, 'url'),
        visible: readBool(params, 'visible') ?? true,
        bounds,
      })
    }
    case 'select_page': {
      const pageId = readPageId(params)
      if (!pageId) throw new Error('pageId is required')
      const bounds = await revealBrowserPanel(options)
      return browserApi.show(pageId, bounds)
    }
    case 'close_page': {
      const pageId = readPageId(params)
      if (!pageId) throw new Error('pageId is required')
      return browserApi.close(pageId)
    }
    case 'navigate_page': {
      const type = readString(params, 'type') as NavigateType | undefined
      if (!type) throw new Error('type is required')
      const bounds = await revealBrowserPanel(options)
      await browserApi.show(readPageId(params), bounds)
      return browserApi.navigate({
        pageId: readPageId(params),
        type,
        url: readString(params, 'url'),
        ignoreCache: readBool(params, 'ignoreCache'),
      })
    }
    case 'evaluate_script':
      await revealBrowserPanel(options)
      return browserApi.evaluateScript(params)
    case 'take_snapshot':
      return browserApi.takeSnapshot(params)
    case 'take_screenshot':
      await revealBrowserPanel(options)
      return browserApi.takeScreenshot(params)
    case 'click':
      await revealBrowserPanel(options)
      return browserApi.click(params)
    case 'hover':
      await revealBrowserPanel(options)
      return browserApi.hover(params)
    case 'fill':
      await revealBrowserPanel(options)
      return browserApi.fill(params)
    case 'fill_form':
      await revealBrowserPanel(options)
      return browserApi.fillForm(params)
    case 'upload_file':
      await revealBrowserPanel(options)
      return browserApi.uploadFile(params)
    case 'wait_for':
      return browserApi.waitFor(params)
    case 'press_key':
      await revealBrowserPanel(options)
      return browserApi.pressKey(params)
    case 'type_text':
      await revealBrowserPanel(options)
      return browserApi.typeText(params)
    case 'handle_dialog':
      return browserApi.handleDialog(params)
    case 'resize_page': {
      const width = readNumber(params, 'width')
      const height = readNumber(params, 'height')
      if (!width || !height) throw new Error('width and height are required')
      await revealBrowserPanel(options)
      return browserApi.resizePage({
        pageId: readPageId(params),
        width,
        height,
      })
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
  await fetch(`${apiBase}/api/browser/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...body }),
  })
}

export function connectBrowserBridge(options: BrowserBridgeOptions) {
  if (!isNativeBrowserAvailable()) return () => undefined

  const source = new EventSource(`${options.apiBase}/api/browser/connect`)

  source.addEventListener('browser_request', (message) => {
    const request = JSON.parse((message as MessageEvent).data) as BrowserBridgeRequest

    void executeBrowserRequest(request, options)
      .then((result) => respond(options.apiBase, request.id, { ok: true, result }))
      .catch((error) => respond(options.apiBase, request.id, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
  })

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) source.close()
  }

  return () => source.close()
}
