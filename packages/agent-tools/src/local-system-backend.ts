import { spawn } from 'node:child_process';
import { lstat, mkdir, writeFile as writeLocalFile } from 'node:fs/promises';
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
import { PathRequiresApprovalError } from '../../agent-runtime/src/index.js';
import { analyzeCommandSafety, isInsideRoot, suggestApprovalRoot } from './command-safety.js';

type LocalSystemBackendOptions = Omit<DeepLocalShellBackendOptions, 'rootDir' | 'virtualMode'> & {
  backend?: SandboxBackendProtocolV2;
  rootDir?: string;
};

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_RESULT_LIMIT = 20;
const DEFAULT_ROOT = '/';

export class LocalSystemBackend implements ExecutableSystemBackend {
  readonly rootDir: string;
  private readonly backend: SandboxBackendProtocolV2;
  private readonly approvedRoots: string[];
  private readonly useLocalFsWrites: boolean;

  constructor(root = DEFAULT_ROOT, options: LocalSystemBackendOptions = {}) {
    this.rootDir = path.resolve(root);
    this.approvedRoots = [this.rootDir];
    this.useLocalFsWrites = !options.backend;

    if (options.backend) {
      this.backend = options.backend;
      return;
    }

    this.backend = new LocalShellBackend({
      ...options,
      inheritEnv: options.inheritEnv ?? true,
      rootDir: options.rootDir ?? this.rootDir,
      virtualMode: false,
    });
  }

  approveWorkspaceRoot(root: string) {
    const fullPath = path.resolve(root);
    const added = !this.isInsideApprovedRoot(fullPath);
    if (added) this.approvedRoots.push(fullPath);
    return { path: fullPath, added };
  }

  revokeWorkspaceRoot(root: string) {
    const fullPath = path.resolve(root);
    const index = this.approvedRoots.findIndex((approvedRoot) => path.resolve(approvedRoot) === fullPath);
    if (index > 0) this.approvedRoots.splice(index, 1);
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
    const target = options?.path ? this.toBackendPath(options.path) : this.rootDir;
    const result = await this.backend.grep(pattern, target, options?.glob ?? null);
    if (result.error) throw new Error(result.error);

    return {
      mode,
      matches: this.formatGrepMatches(result, mode).slice(0, limit),
    };
  }

  async glob(pattern: string, options?: SystemGlobOptions): Promise<SystemGlobResult> {
    const target = options?.path ? this.toBackendPath(options.path) : this.rootDir;
    const limit = options?.limit ?? DEFAULT_RESULT_LIMIT;
    const result = await this.backend.glob(pattern, target);
    if (result.error) throw new Error(result.error);

    return {
      matches: (result.files ?? []).slice(0, limit).map((file) => this.toSystemFileInfo(file)),
    };
  }

  async writeFile(filePath: string, content: string): Promise<SystemWriteResult> {
    const target = this.toBackendPath(filePath);
    if (this.useLocalFsWrites) {
      await writeLocalTextFile(target, content);
      return {
        path: this.fromBackendPath(target),
        bytes: Buffer.byteLength(content, 'utf8'),
      };
    }

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
    const cwd = options?.cwd ? this.toHostPath(options.cwd) : this.rootDir;
    const commandText = args.length > 0 ? formatCommandText(command, args, this.useLocalFsWrites) : command;
    this.assertCommandPathsStayInApprovedRoots(commandText, cwd);
    if (this.useLocalFsWrites) {
      return this.executeLocalCommand(commandText, cwd, startedAt, options?.timeoutMs);
    }

    const result = await withTimeout(this.backend.execute(`cd ${shellQuote(cwd)} && ${commandText}`), options?.timeoutMs, command);
    return {
      exit_code: result.exitCode ?? 1,
      stdout: result.output,
      stderr: '',
      duration_ms: Date.now() - startedAt,
    };
  }

  private async executeLocalCommand(
    commandText: string,
    cwd: string,
    startedAt: number,
    timeoutMs: number | undefined,
  ): Promise<SystemExecuteResult> {
    const result = await runLocalShellCommand(commandText, cwd, timeoutMs);
    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: Date.now() - startedAt,
    };
  }

  private toBackendPath(requestedPath: string) {
    return this.toHostPath(requestedPath);
  }

  private toHostPath(requestedPath: string) {
    const fullPath = path.resolve(this.rootDir, requestedPath);
    if (!this.isInsideApprovedRoot(fullPath)) throw this.createPathApprovalError(fullPath);
    return fullPath;
  }

  private isInsideApprovedRoot(fullPath: string) {
    return this.approvedRoots.some((root) => isInsideRoot(root, fullPath));
  }

  private createPathApprovalError(fullPath: string) {
    return new PathRequiresApprovalError({
      path: fullPath,
      suggestedRoot: suggestApprovalRoot(fullPath),
      reason: `Path requires approval: ${fullPath}`,
    });
  }

  private assertCommandPathsStayInApprovedRoots(commandText: string, cwd: string) {
    const result = analyzeCommandSafety({
      commandText,
      cwd,
      approvedRoots: this.approvedRoots,
    });
    const issue = result.issues[0];
    if (!issue) return;

    throw new PathRequiresApprovalError({
      path: issue.path,
      suggestedRoot: issue.suggestedRoot,
      reason: issue.reason,
    });
  }

  private fromBackendPath(filePath: string) {
    const normalized = path.resolve(this.rootDir, filePath);
    if (isInsideRoot(this.rootDir, normalized)) {
      return path.relative(this.rootDir, normalized) || '.';
    }
    return normalized;
  }

  private toSystemFileInfo(file: { path: string; is_dir?: boolean; size?: number; modified_at?: string }): SystemFileInfo {
    return {
      path: this.fromBackendPath(file.path.replace(/[/\\]$/, '')),
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

function formatCommandText(command: string, args: string[], useLocalShell: boolean) {
  if (useLocalShell && process.platform === 'win32') {
    return `& ${[command, ...args].map(powerShellQuote).join(' ')}`;
  }

  return [command, ...args].map(shellQuote).join(' ');
}

function powerShellQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

type LocalCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runLocalShellCommand(commandText: string, cwd: string, timeoutMs: number | undefined): Promise<LocalCommandResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const windowsCommand = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      '$null = chcp.com 65001',
      commandText,
    ].join('; ');
    const child = isWindows
      ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsCommand], {
          cwd,
          env: {
            ...process.env,
            DOTNET_CLI_UI_LANGUAGE: process.env.DOTNET_CLI_UI_LANGUAGE || 'en',
            PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
          },
          windowsHide: true,
        })
      : spawn(commandText, {
          cwd,
          env: process.env,
          shell: true,
        });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${commandText}`));
      }, timeoutMs);
    }
  });
}

async function writeLocalTextFile(filePath: string, content: string) {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Cannot write to ${filePath} because it is a symlink. Symlinks are not allowed.`);
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
  }

  const parent = path.dirname(filePath);
  if (parent !== path.parse(parent).root) {
    await mkdir(parent, { recursive: true });
  }

  await writeLocalFile(filePath, content, {
    flag: 'w',
    mode: 0o644,
  });
}

async function withTimeout<T>(promise: Promise<T> | T, timeoutMs: number | undefined, command: string) {
  if (!timeoutMs) return promise;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
