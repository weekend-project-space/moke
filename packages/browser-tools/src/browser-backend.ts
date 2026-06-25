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
  page: BrowserPage | null;
  pages: BrowserPage[];
  activePageId: number | null;
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

export type BrowserBackend = {
  listPages(): Promise<BrowserResult>;
  createPage(input: CreatePageInput): Promise<BrowserResult>;
  selectPage(input: SelectPageInput): Promise<BrowserResult>;
  closePage(input: ClosePageInput): Promise<BrowserResult>;
  navigatePage(input: NavigatePageInput): Promise<BrowserResult>;
  showBrowser(): Promise<BrowserResult>;
  hideBrowser(): Promise<BrowserResult>;
};
