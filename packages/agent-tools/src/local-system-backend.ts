import { lstat, mkdir, realpath, writeFile as writeLocalFile } from 'node:fs/promises';
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
  SystemAccessOptions,
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
} from '@moke/agent-runtime';
import { PathRequiresApprovalError } from '@moke/agent-runtime';
import { ShellExecutor, type SandboxMode } from '@moke/shell';
import {
  analyzeCommandSafety,
  analyzePowerShellCompatibility,
  isInsideRoot,
  suggestApprovalRoot,
} from './command-safety.js';

type LocalSystemBackendOptions = Omit<DeepLocalShellBackendOptions, 'rootDir' | 'virtualMode'> & {
  backend?: SandboxBackendProtocolV2;
  rootDir?: string;
  /** Overrides the bundled executor for embedding and tests. */
  shellExecutor?: Pick<ShellExecutor, 'run'>;
  /** Defaults to workspace-write so production commands are confined by default. */
  sandboxMode?: SandboxMode;
};

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_RESULT_LIMIT = 20;
const DEFAULT_ROOT = '/';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export class LocalSystemBackend implements ExecutableSystemBackend {
  readonly rootDir: string;
  private readonly backend: SandboxBackendProtocolV2;
  private readonly globallyApprovedRoots: string[];
  private readonly useLocalFsWrites: boolean;
  private readonly shellExecutor?: Pick<ShellExecutor, 'run'>;
  private readonly defaultSandboxMode: SandboxMode;

  constructor(root = DEFAULT_ROOT, options: LocalSystemBackendOptions = {}) {
    this.rootDir = path.resolve(root);
    this.globallyApprovedRoots = [];
    this.useLocalFsWrites = !options.backend;
    this.shellExecutor = options.shellExecutor ?? (!options.backend ? new ShellExecutor() : undefined);
    this.defaultSandboxMode = options.sandboxMode ?? 'workspace-write';

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
    const added = !this.globallyApprovedRoots.some((approvedRoot) => isInsideRoot(approvedRoot, fullPath));
    if (added) this.globallyApprovedRoots.push(fullPath);
    return { path: fullPath, added };
  }

  revokeWorkspaceRoot(root: string) {
    const fullPath = path.resolve(root);
    const index = this.globallyApprovedRoots.findIndex((approvedRoot) => path.resolve(approvedRoot) === fullPath);
    if (index >= 0) this.globallyApprovedRoots.splice(index, 1);
  }

  async ls(requestedPath = '.', access?: SystemAccessOptions): Promise<SystemLsResult> {
    const target = await this.toBackendPath(requestedPath, access);
    const result = await this.backend.ls(target);
    if (result.error) throw new Error(result.error);

    return {
      path: this.fromBackendPath(target, access),
      entries: (result.files ?? []).map((file) => this.toSystemFileInfo(file, access)),
    };
  }

  async readFile(filePath: string, options?: SystemReadOptions, access?: SystemAccessOptions): Promise<SystemReadResult> {
    const target = await this.toBackendPath(filePath, access, 'file');
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? DEFAULT_READ_LIMIT;
    const result = await this.backend.read(target, offset, limit);
    if (result.error) throw new Error(result.error);
    const raw = await this.backend.readRaw(target);
    const rawText = typeof raw.data?.content === 'string' ? raw.data.content : undefined;
    const totalLines = rawText ? rawText.split(/\r?\n/).length : undefined;

    if (result.content instanceof Uint8Array) {
      return {
        path: this.fromBackendPath(target, access),
        content: '',
        lines: [],
        offset,
        limit,
        content_blocks: [{ type: 'file', path: this.fromBackendPath(target, access), mime_type: result.mimeType }],
      };
    }

    const content = result.content ?? '';
    const lines = content.split(/\r?\n/).map((text, index) => ({
      number: offset + index + 1,
      text,
    }));

    return {
      path: this.fromBackendPath(target, access),
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

  async readImage(filePath: string, access?: SystemAccessOptions) {
    const target = await this.toBackendPath(filePath, access, 'file');
    const result = await this.backend.readRaw(target);
    if (result.error) throw new Error(result.error);
    const content = result.data?.content;
    if (!(content instanceof Uint8Array)) throw new Error(`File is not a supported image: ${filePath}`);
    if (content.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit: ${filePath}`);
    }
    const mimeType = detectImageMimeType(content);
    if (!mimeType) throw new Error(`File is not a supported PNG, JPEG, WebP, or GIF image: ${filePath}`);

    return {
      path: this.fromBackendPath(target, access),
      mime_type: mimeType,
      size: content.byteLength,
      data_url: `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`,
    };
  }

  async grep(pattern: string, options?: SystemGrepOptions, access?: SystemAccessOptions): Promise<SystemGrepResult> {
    const mode = options?.mode ?? 'content';
    const limit = options?.limit ?? DEFAULT_RESULT_LIMIT;
    const target = options?.path
      ? await this.toBackendPath(options.path, access)
      : await this.approvedPath(this.workspaceRoot(access), access);
    const result = await this.backend.grep(pattern, target, options?.glob ?? null);
    if (result.error) throw new Error(result.error);

    return {
      mode,
      matches: this.formatGrepMatches(result, mode, access).slice(0, limit),
    };
  }

  async glob(pattern: string, options?: SystemGlobOptions, access?: SystemAccessOptions): Promise<SystemGlobResult> {
    const target = options?.path
      ? await this.toBackendPath(options.path, access)
      : await this.approvedPath(this.workspaceRoot(access), access);
    const limit = options?.limit ?? DEFAULT_RESULT_LIMIT;
    const result = await this.backend.glob(pattern, target);
    if (result.error) throw new Error(result.error);

    return {
      matches: (result.files ?? []).slice(0, limit).map((file) => this.toSystemFileInfo(file, access)),
    };
  }

  async writeFile(filePath: string, content: string, access?: SystemAccessOptions): Promise<SystemWriteResult> {
    const target = await this.toWritablePath(filePath, access);
    if (this.useLocalFsWrites) {
      await writeLocalTextFile(target, content);
      return {
        path: this.fromBackendPath(target, access),
        bytes: Buffer.byteLength(content, 'utf8'),
      };
    }

    const result = await this.backend.write(target, content);
    if (result.error) throw new Error(result.error);

    return {
      path: this.fromBackendPath(result.path ?? target, access),
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  }

  async editFile(
    filePath: string,
    oldString: string,
    newString: string,
    options?: { replaceAll?: boolean }, access?: SystemAccessOptions,
  ): Promise<SystemEditResult> {
    const target = await this.toWritablePath(filePath, access);
    const result = await this.backend.edit(target, oldString, newString, options?.replaceAll ?? false);
    if (result.error) throw new Error(result.error);

    return {
      path: this.fromBackendPath(result.path ?? target, access),
      replacements: result.occurrences ?? 0,
    };
  }

  async execute(command: string, args: string[] = [], options?: SystemExecuteOptions, access?: SystemAccessOptions): Promise<SystemExecuteResult> {
    const startedAt = Date.now();
    const sandboxMode = access?.sandboxMode ?? this.defaultSandboxMode;
    const cwd = await this.executionCwd(options?.cwd, access, sandboxMode);
    const commandText = args.length > 0 ? formatCommandText(command, args) : command;
    this.assertCommandPathsStayInApprovedRoots(commandText, cwd, access, sandboxMode);

    if (this.shellExecutor) {
      const result = await this.shellExecutor.run({
        command: commandText,
        workdir: cwd,
        sandbox: { mode: sandboxMode, workspaceRoot: this.workspaceRoot(access) },
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      });
      return {
        exit_code: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr || result.error?.message || '',
        duration_ms: result.durationMs,
        status: result.status,
        error_code: result.error?.code,
        stdout_truncated: result.stdoutTruncated,
        stderr_truncated: result.stderrTruncated,
        sandbox: {
          mode: result.sandbox.mode,
          enforced: result.sandbox.enforced,
          denied: result.sandbox.denied,
        },
      };
    }

    const result = await withTimeout(this.backend.execute(`cd ${shellQuote(cwd)} && ${commandText}`), options?.timeoutMs, command);
    return {
      exit_code: result.exitCode ?? 1,
      stdout: result.output,
      stderr: '',
      duration_ms: Date.now() - startedAt,
    };
  }

  private async executionCwd(requestedPath: string | undefined, access: SystemAccessOptions | undefined, sandboxMode: SandboxMode) {
    if (!requestedPath) return this.approvedPath(this.workspaceRoot(access), access);
    if (sandboxMode === 'danger-full-access') return path.resolve(this.workspaceRoot(access), requestedPath);
    return this.toHostPath(requestedPath, access);
  }

  private async toBackendPath(requestedPath: string, access?: SystemAccessOptions, approvalScope: 'file' | 'directory' = 'directory') {
    return this.toHostPath(requestedPath, access, approvalScope);
  }

  private async toWritablePath(requestedPath: string, access?: SystemAccessOptions) {
    const sandboxMode = access?.sandboxMode ?? this.defaultSandboxMode;
    if (sandboxMode === 'read-only') {
      throw new Error('Writes are disabled in read-only mode');
    }

    const workspaceRoot = this.workspaceRoot(access);
    const fullPath = path.resolve(workspaceRoot, requestedPath);
    if (sandboxMode === 'danger-full-access') return fullPath;

    if (isInsideRoot(workspaceRoot, fullPath)) {
      const [realWorkspaceRoot, realTarget] = await Promise.all([
        resolveRealPath(workspaceRoot),
        resolveRealPath(fullPath),
      ]);
      if (isInsideRoot(realWorkspaceRoot, realTarget)) return fullPath;
    }
    throw new Error(`Write path must be inside workspaceRoot for workspace-write: ${fullPath}`);
  }

  private async toHostPath(requestedPath: string, access?: SystemAccessOptions, approvalScope: 'file' | 'directory' = 'directory') {
    const fullPath = path.resolve(this.workspaceRoot(access), requestedPath);
    if (!this.isInsideApprovedRoot(fullPath, access)) throw this.createPathApprovalError(fullPath, approvalScope);
    await this.assertRealPathInsideApprovedRoots(fullPath, access, approvalScope);
    return fullPath;
  }

  private async approvedPath(fullPath: string, access?: SystemAccessOptions) {
    await this.assertRealPathInsideApprovedRoots(fullPath, access, 'directory');
    return fullPath;
  }

  private async assertRealPathInsideApprovedRoots(
    fullPath: string,
    access: SystemAccessOptions | undefined,
    approvalScope: 'file' | 'directory',
  ) {
    const roots = [
      this.workspaceRoot(access),
      ...this.globallyApprovedRoots,
      ...(access?.approvedRoots || []),
    ];
    const realRoots = await Promise.all(roots.map((root) => resolveRealPath(root)));
    const candidate = await resolveRealPath(fullPath);
    if (!realRoots.some((root) => isInsideRoot(root, candidate))) {
      throw this.createPathApprovalError(fullPath, approvalScope);
    }
  }

  private isInsideApprovedRoot(fullPath: string, access?: SystemAccessOptions) {
    return [
      this.workspaceRoot(access),
      ...this.globallyApprovedRoots,
      ...(access?.approvedRoots || []),
    ].some((root) => isInsideRoot(root, fullPath));
  }

  private createPathApprovalError(fullPath: string, approvalScope: 'file' | 'directory' = 'directory') {
    return new PathRequiresApprovalError({
      path: fullPath,
      suggestedRoot: approvalScope === 'file' ? fullPath : suggestApprovalRoot(fullPath),
      reason: `Path requires approval: ${fullPath}`,
    });
  }

  private assertCommandPathsStayInApprovedRoots(
    commandText: string,
    cwd: string,
    access: SystemAccessOptions | undefined,
    sandboxMode: SandboxMode,
  ) {
    if (process.platform === 'win32') {
      const compatibilityIssue = analyzePowerShellCompatibility(commandText).issues[0];
      if (compatibilityIssue) throw new Error(compatibilityIssue.reason);
    }
    if (sandboxMode === 'danger-full-access') return;

    const result = analyzeCommandSafety({
      commandText,
      cwd,
      approvedRoots: [
        this.workspaceRoot(access),
        ...this.globallyApprovedRoots,
        ...(access?.approvedRoots || []),
      ],
    });
    const issue = result.issues[0];
    if (!issue) return;

    throw new PathRequiresApprovalError({
      path: issue.path,
      suggestedRoot: issue.suggestedRoot,
      reason: issue.reason,
    });
  }

  private workspaceRoot(access?: SystemAccessOptions) {
    return path.resolve(access?.workspaceRoot || this.rootDir);
  }

  private fromBackendPath(filePath: string, access?: SystemAccessOptions) {
    const workspaceRoot = this.workspaceRoot(access);
    const normalized = path.resolve(workspaceRoot, filePath);
    if (isInsideRoot(workspaceRoot, normalized)) {
      return path.relative(workspaceRoot, normalized) || '.';
    }
    return normalized;
  }

  private toSystemFileInfo(
    file: { path: string; is_dir?: boolean; size?: number; modified_at?: string },
    access?: SystemAccessOptions,
  ): SystemFileInfo {
    return {
      path: this.fromBackendPath(file.path.replace(/[/\\]$/, ''), access),
      type: file.is_dir ? 'directory' : 'file',
      size: file.size,
      modified_at: file.modified_at || undefined,
    };
  }

  private formatGrepMatches(result: GrepResult, mode: SystemGrepMode, access?: SystemAccessOptions) {
    const matches = result.matches ?? [];
    if (mode === 'files') {
      return [...new Set(matches.map((match) => match.path))].map((filePath) => ({
        path: this.fromBackendPath(filePath, access),
      }));
    }
    if (mode === 'count') {
      const counts = new Map<string, number>();
      for (const match of matches) {
        counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
      }
      return [...counts.entries()].map(([filePath, count]) => ({
        path: this.fromBackendPath(filePath, access),
        count,
      }));
    }

    return matches.map((match: GrepMatch) => ({
      path: this.fromBackendPath(match.path, access),
      line: match.line,
      text: match.text,
    }));
  }
}

function detectImageMimeType(content: Uint8Array) {
  if (
    content.length >= 8
    && content[0] === 0x89
    && content[1] === 0x50
    && content[2] === 0x4e
    && content[3] === 0x47
    && content[4] === 0x0d
    && content[5] === 0x0a
    && content[6] === 0x1a
    && content[7] === 0x0a
  ) return 'image/png';
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return 'image/jpeg';
  }
  if (content.length >= 6) {
    const signature = Buffer.from(content.subarray(0, 6)).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    content.length >= 12
    && Buffer.from(content.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(content.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return undefined;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCommandText(command: string, args: string[]) {
  if (process.platform === 'win32') {
    return `& ${[command, ...args].map(powerShellQuote).join(' ')}`;
  }

  return [command, ...args].map(shellQuote).join(' ');
}

function powerShellQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function resolveRealPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const parent = path.dirname(candidate);
    if (code === 'ENOENT' && parent !== candidate) {
      const realParent = await resolveRealPath(parent);
      return path.join(realParent, path.basename(candidate));
    }
    throw error;
  }
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
