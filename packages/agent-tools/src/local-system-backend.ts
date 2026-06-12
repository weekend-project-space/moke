import path from 'node:path';

import {
  LocalShellBackend,
  type LocalShellBackendOptions as DeepLocalShellBackendOptions,
  type SandboxBackendProtocolV2,
  type GrepMatch,
  type GrepResult,
} from 'deepagents';

import type {
  ExecutableSystemBackend,
  SystemEditResult,
  SystemExecuteOptions,
  SystemExecuteResult,
  SystemFileInfo,
  SystemGlobOptions,
  SystemGlobResult,
  SystemGrepMode,
  SystemGrepOptions,
  SystemGrepResult,
  SystemLsResult,
  SystemReadOptions,
  SystemReadResult,
  SystemWriteResult,
} from '../../agent-runtime/src/index.js';

type LocalSystemBackendOptions = Omit<DeepLocalShellBackendOptions, 'rootDir' | 'virtualMode'> & {
  backend?: SandboxBackendProtocolV2;
  rootDir?: string;
};

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_RESULT_LIMIT = 20;
const DEFAULT_ROOT = '/';

export class LocalSystemBackend implements ExecutableSystemBackend {
  readonly root: string;
  private readonly backend: SandboxBackendProtocolV2;

  constructor(root = DEFAULT_ROOT, options: LocalSystemBackendOptions = {}) {
    this.root = path.resolve(root);

    if (options.backend) {
      this.backend = options.backend;
      return;
    }

    this.backend = new LocalShellBackend({
      ...options,
      inheritEnv: options.inheritEnv ?? true,
      rootDir: options.rootDir ?? this.root,
      virtualMode: true,
    });
  }

  async ls(requestedPath = '.'): Promise<SystemLsResult> {
    const target = this.toBackendPath(requestedPath);
    const result = await this.backend.ls(target);
    if (result.error) throw new Error(result.error);

    return {
      path: this.fromBackendPath(target),
      entries: (result.files ?? []).map((file) => this.toSystemFileInfo(file)),
    };
  }

  async readFile(filePath: string, options?: SystemReadOptions): Promise<SystemReadResult> {
    const target = this.toBackendPath(filePath);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? DEFAULT_READ_LIMIT;
    const result = await this.backend.read(target, offset, limit);
    if (result.error) throw new Error(result.error);
    const raw = await this.backend.readRaw(target);
    const rawText = typeof raw.data?.content === 'string' ? raw.data.content : undefined;
    const totalLines = rawText ? rawText.split(/\r?\n/).length : undefined;

    if (result.content instanceof Uint8Array) {
      return {
        path: this.fromBackendPath(target),
        content: '',
        lines: [],
        offset,
        limit,
        content_blocks: [{ type: 'file', path: this.fromBackendPath(target), mime_type: result.mimeType }],
      };
    }

    const content = result.content ?? '';
    const lines = content.split(/\r?\n/).map((text, index) => ({
      number: offset + index + 1,
      text,
    }));

    return {
      path: this.fromBackendPath(target),
      content,
      lines,
      offset,
      limit,
      start_line: lines.length > 0 ? lines[0].number : undefined,
      end_line: lines.length > 0 ? lines[lines.length - 1].number : undefined,
      total_lines: totalLines,
      truncated: totalLines === undefined ? lines.length >= limit : offset + lines.length < totalLines,
      content_blocks: [{ type: 'text', text: content }],
    };
  }

  async grep(pattern: string, options?: SystemGrepOptions): Promise<SystemGrepResult> {
    const mode = options?.mode ?? 'content';
    const limit = options?.limit ?? DEFAULT_RESULT_LIMIT;
    const target = options?.path ? this.toBackendPath(options.path) : DEFAULT_ROOT;
    const result = await this.backend.grep(pattern, target, options?.glob ?? null);
    if (result.error) throw new Error(result.error);

    return {
      mode,
      matches: this.formatGrepMatches(result, mode).slice(0, limit),
    };
  }

  async glob(pattern: string, options?: SystemGlobOptions): Promise<SystemGlobResult> {
    const target = options?.path ? this.toBackendPath(options.path) : DEFAULT_ROOT;
    const limit = options?.limit ?? DEFAULT_RESULT_LIMIT;
    const result = await this.backend.glob(pattern, target);
    if (result.error) throw new Error(result.error);

    return {
      matches: (result.files ?? []).slice(0, limit).map((file) => this.toSystemFileInfo(file)),
    };
  }

  async writeFile(filePath: string, content: string): Promise<SystemWriteResult> {
    const target = this.toBackendPath(filePath);
    const result = await this.backend.write(target, content);
    if (result.error) throw new Error(result.error);

    return {
      path: this.fromBackendPath(result.path ?? target),
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  }

  async editFile(
    filePath: string,
    oldString: string,
    newString: string,
    options?: { replaceAll?: boolean },
  ): Promise<SystemEditResult> {
    const target = this.toBackendPath(filePath);
    const result = await this.backend.edit(target, oldString, newString, options?.replaceAll ?? false);
    if (result.error) throw new Error(result.error);

    return {
      path: this.fromBackendPath(result.path ?? target),
      replacements: result.occurrences ?? 0,
    };
  }

  async execute(command: string, args: string[] = [], options?: SystemExecuteOptions): Promise<SystemExecuteResult> {
    const startedAt = Date.now();
    const cwd = options?.cwd ? this.toHostPath(options.cwd) : undefined;
    const commandText = args.length > 0 ? [command, ...args].map(shellQuote).join(' ') : command;
    const commands = 'export OPENWALK_SESSION_NAME=MOKE && ' + commandText
    const result = await this.backend.execute(cwd ? `cd ${shellQuote(cwd)} && ${commands}` : commands);

    return {
      exit_code: result.exitCode ?? 1,
      stdout: result.output,
      stderr: '',
      duration_ms: Date.now() - startedAt,
    };
  }

  private toBackendPath(requestedPath: string) {
    if (path.isAbsolute(requestedPath) && requestedPath.startsWith(this.root)) {
      return this.toVirtualPath(requestedPath);
    }
    return this.toVirtualPath(this.toHostPath(requestedPath));
  }

  private toHostPath(requestedPath: string) {
    const fullPath = path.resolve(this.root, requestedPath);
    if (fullPath !== this.root && !fullPath.startsWith(`${this.root}${path.sep}`)) {
      throw new Error('Path escapes workspace');
    }
    return fullPath;
  }

  private toVirtualPath(fullPath: string) {
    const relative = path.relative(this.root, fullPath).split(path.sep).join('/');
    return relative ? `/${relative}` : '/';
  }

  private fromBackendPath(filePath: string) {
    const normalized = filePath.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === '' || normalized === '/') return '.';
    if (path.isAbsolute(normalized) && normalized.startsWith(this.root)) {
      return path.relative(this.root, normalized) || '.';
    }
    return normalized.replace(/^\//, '') || '.';
  }

  private toSystemFileInfo(file: { path: string; is_dir?: boolean; size?: number; modified_at?: string }): SystemFileInfo {
    return {
      path: this.fromBackendPath(file.path.replace(/\/$/, '')),
      type: file.is_dir ? 'directory' : 'file',
      size: file.size,
      modified_at: file.modified_at || undefined,
    };
  }

  private formatGrepMatches(result: GrepResult, mode: SystemGrepMode) {
    const matches = result.matches ?? [];
    if (mode === 'files') {
      return [...new Set(matches.map((match) => match.path))].map((filePath) => ({
        path: this.fromBackendPath(filePath),
      }));
    }
    if (mode === 'count') {
      const counts = new Map<string, number>();
      for (const match of matches) {
        counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
      }
      return [...counts.entries()].map(([filePath, count]) => ({
        path: this.fromBackendPath(filePath),
        count,
      }));
    }

    return matches.map((match: GrepMatch) => ({
      path: this.fromBackendPath(match.path),
      line: match.line,
      text: match.text,
    }));
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
