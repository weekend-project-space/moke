import type { ServerResponse } from 'node:http';

import type {
  BrowserActionResult,
  BrowserBackend,
  BrowserResult,
  ClickInput,
  ClosePageInput,
  CreatePageInput,
  ElementActionInput,
  EvaluateScriptInput,
  FillFormInput,
  FillInput,
  HandleDialogInput,
  NavigatePageInput,
  PressKeyInput,
  ResizePageInput,
  SelectPageInput,
  TakeScreenshotInput,
  TakeSnapshotInput,
  TypeTextInput,
  UploadFileInput,
  WaitForInput,
} from '@moke/browser-tools';

type BrowserRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 30000;

function normalizeBrowserResult(result: Record<string, unknown>): BrowserActionResult {
  const { page: _page, ...rest } = result;
  return rest as BrowserActionResult;
}

export class BrowserBridge {
  private client: ServerResponse | null = null;
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingRequest>();

  connect(res: ServerResponse) {
    this.closeClient(new Error('Browser bridge client was replaced'));
    this.client = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ status: 'connected' })}\n\n`);
  }

  disconnect(res: ServerResponse) {
    if (this.client !== res) return;
    this.client = null;
    this.rejectPending(new Error('Browser bridge disconnected'));
  }

  close(error = new Error('Browser bridge closed')) {
    this.closeClient(error);
  }

  private rejectPending(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.client) throw new Error('In-app browser is not connected');

    const id = `browser_req_${++this.requestSeq}`;
    const request: BrowserRequest = { id, method, params };

    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    try {
      this.client.write(`event: browser_request\ndata: ${JSON.stringify(request)}\n\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  respond(id: string, response: { ok?: boolean; result?: Record<string, unknown>; error?: string }) {
    const pending = this.pending.get(id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (response.ok === false) {
      pending.reject(new Error(response.error || 'Browser request failed'));
    } else {
      pending.resolve(response.result || {});
    }

    return true;
  }

  private closeClient(error: Error) {
    if (this.client) {
      // End the SSE stream explicitly so the desktop client can reconnect cleanly.
      this.client.end();
      this.client = null;
    }

    this.rejectPending(error);
  }
}

export class BrowserBridgeBackend implements BrowserBackend {
  constructor(private readonly bridge: BrowserBridge) {}

  async listPages(): Promise<BrowserResult> {
    return this.callBrowser('list_pages');
  }

  async createPage(input: CreatePageInput): Promise<BrowserResult> {
    return this.callBrowser('create_page', input);
  }

  async selectPage(input: SelectPageInput): Promise<BrowserResult> {
    return this.callBrowser('select_page', input);
  }

  async closePage(input: ClosePageInput): Promise<BrowserResult> {
    return this.callBrowser('close_page', input);
  }

  async navigatePage(input: NavigatePageInput): Promise<BrowserResult> {
    return this.callBrowser('navigate_page', input, input.timeout);
  }

  async evaluateScript(input: EvaluateScriptInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('evaluate_script', input);
  }

  async takeSnapshot(input: TakeSnapshotInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('take_snapshot', input);
  }

  async takeScreenshot(input: TakeScreenshotInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('take_screenshot', input);
  }

  async click(input: ClickInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('click', input);
  }

  async hover(input: ElementActionInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('hover', input);
  }

  async fill(input: FillInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('fill', input);
  }

  async fillForm(input: FillFormInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('fill_form', input);
  }

  async uploadFile(input: UploadFileInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('upload_file', input);
  }

  async waitFor(input: WaitForInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('wait_for', input, input.timeout);
  }

  async pressKey(input: PressKeyInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('press_key', input);
  }

  async typeText(input: TypeTextInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('type_text', input);
  }

  async handleDialog(input: HandleDialogInput): Promise<BrowserActionResult> {
    return this.callBrowser<BrowserActionResult>('handle_dialog', input);
  }

  async resizePage(input: ResizePageInput): Promise<BrowserResult> {
    return this.callBrowser('resize_page', input);
  }

  async showBrowser(): Promise<BrowserResult> {
    return this.callBrowser('show_browser');
  }

  async hideBrowser(): Promise<BrowserResult> {
    return this.callBrowser('hide_browser');
  }

  private async callBrowser<T extends BrowserResult = BrowserResult>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const result = await this.bridge.request(method, params, timeoutMs);
    return normalizeBrowserResult(result) as T;
  }
}
