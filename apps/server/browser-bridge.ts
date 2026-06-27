import type { ServerResponse } from 'node:http';

import type {
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
} from '../../packages/browser-tools/src/index.js';

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

export class BrowserBridge {
  private client: ServerResponse | null = null;
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingRequest>();

  connect(res: ServerResponse) {
    this.closeClient();
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
    if (this.client === res) this.client = null;
  }

  close(error = new Error('Browser bridge closed')) {
    this.closeClient();
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

    this.client.write(`event: browser_request\ndata: ${JSON.stringify(request)}\n\n`);
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

  private closeClient() {
    if (!this.client) return;

    // End the SSE stream explicitly so the desktop client can reconnect cleanly.
    this.client.end();
    this.client = null;
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

  async evaluateScript(input: EvaluateScriptInput): Promise<BrowserResult> {
    return this.callBrowser('evaluate_script', input);
  }

  async takeSnapshot(input: TakeSnapshotInput): Promise<BrowserResult> {
    return this.callBrowser('take_snapshot', input);
  }

  async takeScreenshot(input: TakeScreenshotInput): Promise<BrowserResult> {
    return this.callBrowser('take_screenshot', input);
  }

  async click(input: ClickInput): Promise<BrowserResult> {
    return this.callBrowser('click', input);
  }

  async hover(input: ElementActionInput): Promise<BrowserResult> {
    return this.callBrowser('hover', input);
  }

  async fill(input: FillInput): Promise<BrowserResult> {
    return this.callBrowser('fill', input);
  }

  async fillForm(input: FillFormInput): Promise<BrowserResult> {
    return this.callBrowser('fill_form', input);
  }

  async uploadFile(input: UploadFileInput): Promise<BrowserResult> {
    return this.callBrowser('upload_file', input);
  }

  async waitFor(input: WaitForInput): Promise<BrowserResult> {
    return this.callBrowser('wait_for', input, input.timeout);
  }

  async pressKey(input: PressKeyInput): Promise<BrowserResult> {
    return this.callBrowser('press_key', input);
  }

  async typeText(input: TypeTextInput): Promise<BrowserResult> {
    return this.callBrowser('type_text', input);
  }

  async handleDialog(input: HandleDialogInput): Promise<BrowserResult> {
    return this.callBrowser('handle_dialog', input);
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

  private async callBrowser(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.bridge.request(method, params, timeoutMs) as Promise<BrowserResult>;
  }
}
