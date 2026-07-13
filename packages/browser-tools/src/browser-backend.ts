export type BrowserPage = {
  pageId: number;
  label: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  visible: boolean;
};

export type BrowserResult = {
  pages: BrowserPage[];
  activePageId: number | null;
};

export type BrowserActionResult = BrowserResult & {
  snapshot?: BrowserSnapshot;
  value?: unknown;
  matched?: string;
};

export type BrowserSnapshotNode = {
  uid: string;
  role: string;
  name: string;
  tag: string;
  text?: string;
  value?: string;
  href?: string;
  disabled?: boolean;
  visible?: boolean;
  children?: BrowserSnapshotNode[];
};

export type BrowserSnapshotContent = {
  markdown: string;
  truncated: boolean;
};

export type BrowserSnapshot = {
  url: string;
  title: string;
  content: BrowserSnapshotContent;
  elements: BrowserSnapshotNode[];
};

export type CreatePageInput = {
  url?: string;
  visible?: boolean;
};

export type SelectPageInput = {
  pageId: number;
};

export type ClosePageInput = {
  pageId: number;
};

export type NavigatePageInput = {
  pageId?: number;
  type: 'url' | 'back' | 'forward' | 'reload';
  url?: string;
  timeout?: number;
  ignoreCache?: boolean;
};

export type EvaluateScriptInput = {
  pageId?: number;
  function: string;
  args?: unknown[];
  dialogAction?: string;
};

export type TakeSnapshotInput = {
  pageId?: number;
  verbose?: boolean;
  filePath?: string;
};

export type TakeScreenshotInput = {
  pageId?: number;
  path?: string;
  fullPage?: boolean;
  uid?: string;
};

export type ElementActionInput = {
  pageId?: number;
  uid: string;
  includeSnapshot?: boolean;
};

export type ClickInput = ElementActionInput & {
  dblClick?: boolean;
};

export type FillInput = ElementActionInput & {
  value: string;
};

export type FillFormInput = {
  pageId?: number;
  elements: Array<{
    uid: string;
    value: string;
  }>;
  includeSnapshot?: boolean;
};

export type UploadFileInput = ElementActionInput & {
  filePath: string;
};

export type WaitForInput = {
  pageId?: number;
  text: string | string[];
  timeout?: number;
};

export type PressKeyInput = {
  pageId?: number;
  key: string;
  includeSnapshot?: boolean;
};

export type HandleDialogInput = {
  pageId?: number;
  action: 'accept' | 'dismiss';
  promptText?: string;
};

export type TypeTextInput = {
  pageId?: number;
  text: string;
  submitKey?: string;
};

export type ResizePageInput = {
  pageId?: number;
  width: number;
  height: number;
};

export type BrowserBackend = {
  listPages(): Promise<BrowserResult>;
  createPage(input: CreatePageInput): Promise<BrowserResult>;
  selectPage(input: SelectPageInput): Promise<BrowserResult>;
  closePage(input: ClosePageInput): Promise<BrowserResult>;
  navigatePage(input: NavigatePageInput): Promise<BrowserResult>;
  evaluateScript(input: EvaluateScriptInput): Promise<BrowserActionResult>;
  takeSnapshot(input: TakeSnapshotInput): Promise<BrowserActionResult>;
  takeScreenshot(input: TakeScreenshotInput): Promise<BrowserActionResult>;
  click(input: ClickInput): Promise<BrowserActionResult>;
  hover(input: ElementActionInput): Promise<BrowserActionResult>;
  fill(input: FillInput): Promise<BrowserActionResult>;
  fillForm(input: FillFormInput): Promise<BrowserActionResult>;
  uploadFile(input: UploadFileInput): Promise<BrowserActionResult>;
  waitFor(input: WaitForInput): Promise<BrowserActionResult>;
  pressKey(input: PressKeyInput): Promise<BrowserActionResult>;
  typeText(input: TypeTextInput): Promise<BrowserActionResult>;
  handleDialog(input: HandleDialogInput): Promise<BrowserActionResult>;
  resizePage(input: ResizePageInput): Promise<BrowserResult>;
  showBrowser(): Promise<BrowserResult>;
  hideBrowser(): Promise<BrowserResult>;
};
