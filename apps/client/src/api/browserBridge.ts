import { browserApi, isNativeBrowserAvailable, type BrowserResult } from './browser'

type BrowserBridgeRequest = {
  id: string
  method: string
  params?: Record<string, unknown>
}

type BrowserBridgeOptions = {
  apiBase: string
  showBrowserPanel: () => void
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

async function executeBrowserRequest(
  request: BrowserBridgeRequest,
  options: BrowserBridgeOptions,
): Promise<BrowserResult> {
  if (!isNativeBrowserAvailable()) throw new Error('Tauri browser API is not available')

  const params = request.params || {}

  switch (request.method) {
    case 'list_pages':
      return browserApi.state()
    case 'create_page':
      options.showBrowserPanel()
      return browserApi.open({
        url: readString(params, 'url'),
        visible: readBool(params, 'visible') ?? true,
      })
    case 'select_page': {
      const pageId = readPageId(params)
      if (!pageId) throw new Error('pageId is required')
      options.showBrowserPanel()
      return browserApi.show(pageId)
    }
    case 'close_page': {
      const pageId = readPageId(params)
      if (!pageId) throw new Error('pageId is required')
      return browserApi.close(pageId)
    }
    case 'navigate_page': {
      const type = readString(params, 'type') as NavigateType | undefined
      if (!type) throw new Error('type is required')
      options.showBrowserPanel()
      return browserApi.navigate({
        pageId: readPageId(params),
        type,
        url: readString(params, 'url'),
        ignoreCache: readBool(params, 'ignoreCache'),
      })
    }
    case 'evaluate_script':
      options.showBrowserPanel()
      return browserApi.evaluateScript(params)
    case 'take_snapshot':
      return browserApi.takeSnapshot(params)
    case 'take_screenshot':
      options.showBrowserPanel()
      return browserApi.takeScreenshot(params)
    case 'click':
      options.showBrowserPanel()
      return browserApi.click(params)
    case 'hover':
      options.showBrowserPanel()
      return browserApi.hover(params)
    case 'fill':
      options.showBrowserPanel()
      return browserApi.fill(params)
    case 'fill_form':
      options.showBrowserPanel()
      return browserApi.fillForm(params)
    case 'upload_file':
      options.showBrowserPanel()
      return browserApi.uploadFile(params)
    case 'wait_for':
      return browserApi.waitFor(params)
    case 'press_key':
      options.showBrowserPanel()
      return browserApi.pressKey(params)
    case 'type_text':
      options.showBrowserPanel()
      return browserApi.typeText(params)
    case 'handle_dialog':
      return browserApi.handleDialog(params)
    case 'resize_page': {
      const width = readNumber(params, 'width')
      const height = readNumber(params, 'height')
      if (!width || !height) throw new Error('width and height are required')
      options.showBrowserPanel()
      return browserApi.resizePage({
        pageId: readPageId(params),
        width,
        height,
      })
    }
    case 'show_browser':
      options.showBrowserPanel()
      return browserApi.state()
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
