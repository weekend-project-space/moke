export type SystemFileType = 'file' | 'directory';

export type SystemFileInfo = {
  path: string;
  type: SystemFileType;
  size?: number;
  modified_at?: string;
};

export type SystemLsResult = {
  path: string;
  entries: SystemFileInfo[];
};

export type SystemContentBlock =
  | { type: 'text'; text: string }
  | { type: 'file'; path: string; mime_type?: string };

export type SystemReadOptions = {
  offset?: number;
  limit?: number;
};

export type SystemAccessOptions = {
  workspaceRoot?: string;
  approvedRoots?: string[];
};

export type SystemReadLine = {
  number: number;
  text: string;
};

export type SystemReadResult = {
  path: string;
  content: string;
  lines: SystemReadLine[];
  offset: number;
  limit?: number;
  start_line?: number;
  end_line?: number;
  total_lines?: number;
  truncated?: boolean;
  content_blocks?: SystemContentBlock[];
};

export type SystemWriteResult = {
  path: string;
  bytes: number;
};

export type SystemEditResult = {
  path: string;
  replacements: number;
};

export type SystemGrepOptions = {
  path?: string;
  glob?: string;
  mode?: SystemGrepMode;
  contextLines?: number;
  limit?: number;
};

export type SystemGrepMode = 'files' | 'content' | 'count';

export type SystemGrepMatch = {
  path: string;
  line?: number;
  text?: string;
  count?: number;
  before?: string[];
  after?: string[];
};

export type SystemGrepResult = {
  mode: SystemGrepMode;
  matches: SystemGrepMatch[];
};

export type SystemGlobOptions = {
  path?: string;
  limit?: number;
};

export type SystemGlobResult = {
  matches: SystemFileInfo[];
};

export type SystemExecuteOptions = {
  cwd?: string;
  timeoutMs?: number;
};

export type SystemExecuteResult = {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms?: number;
};

export interface SystemBackend {
  readonly rootDir: string;

  ls(path?: string, access?: SystemAccessOptions): Promise<SystemLsResult>;
  readFile(path: string, options?: SystemReadOptions, access?: SystemAccessOptions): Promise<SystemReadResult>;
  readImage(path: string, access?: SystemAccessOptions): Promise<{
    path: string;
    mime_type: string;
    size: number;
    data_url: string;
  }>;
  grep(pattern: string, options?: SystemGrepOptions, access?: SystemAccessOptions): Promise<SystemGrepResult>;
  glob(pattern: string, options?: SystemGlobOptions, access?: SystemAccessOptions): Promise<SystemGlobResult>;
}

export interface WritableSystemBackend extends SystemBackend {
  writeFile(path: string, content: string, access?: SystemAccessOptions): Promise<SystemWriteResult>;
  editFile(
    path: string,
    oldString: string,
    newString: string,
    options?: { replaceAll?: boolean }, access?: SystemAccessOptions,
  ): Promise<SystemEditResult>;
}

export interface ExecutableSystemBackend extends WritableSystemBackend {
  execute(command: string, args?: string[], options?: SystemExecuteOptions, access?: SystemAccessOptions): Promise<SystemExecuteResult>;
}
