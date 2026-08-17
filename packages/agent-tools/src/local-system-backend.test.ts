import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ShellRequest, ShellResult } from '@moke/shell';
import { LocalSystemBackend } from './local-system-backend.js';

function createBackend(options: { executeDelayMs?: number; rawContent?: Uint8Array } = {}) {
  const calls: string[] = [];
  const backend = {
    id: 'fake-backend',
    calls,
    async ls() {
      return {};
    },
    async read() {
      return {};
    },
    async readRaw() {
      return options.rawContent
        ? {
            data: {
              content: options.rawContent,
              mimeType: 'application/octet-stream',
              created_at: new Date(0).toISOString(),
              modified_at: new Date(0).toISOString(),
            },
          }
        : {};
    },
    async grep() {
      return {};
    },
    async glob() {
      return {};
    },
    async write() {
      return {};
    },
    async edit() {
      return {};
    },
    async execute(command: string) {
      calls.push(command);
      if (options.executeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.executeDelayMs));
      }
      return { exitCode: 0, output: 'ok', truncated: false };
    },
  };

  return backend;
}

function completedShellResult(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    status: 'completed',
    stdout: 'shell stdout',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    durationMs: 12,
    sandbox: {
      mode: 'workspace-write',
      enforced: true,
      enforcement: 'full',
      denied: false,
      runner: 'test',
    },
    ...overrides,
  };
}

test('execute delegates local commands to ShellExecutor with workspace confinement', async () => {
  const calls: ShellRequest[] = [];
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, {
    backend,
    shellExecutor: {
      async run(request) {
        calls.push(request);
        return completedShellResult();
      },
    },
  });
  const controller = new AbortController();

  const result = await system.execute('node', ['-e', "process.stdout.write('ok')"], {
    cwd: 'packages',
    timeoutMs: 5000,
    signal: controller.signal,
  });

  assert.equal(backend.calls.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workdir, path.join(workspace, 'packages'));
  assert.equal(calls[0].sandbox.mode, 'workspace-write');
  assert.equal(calls[0].sandbox.workspaceRoot, workspace);
  assert.equal(calls[0].timeoutMs, 5000);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(result.stdout, 'shell stdout');
  assert.equal(result.sandbox?.enforced, true);
});

test('execute preserves structured shell timeout and denial results', async () => {
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, {
    shellExecutor: {
      async run() {
        return completedShellResult({
          status: 'timed_out',
          exitCode: undefined,
          stderr: '',
          sandbox: {
            mode: 'workspace-write',
            enforced: true,
            enforcement: 'full',
            denied: true,
            runner: 'test',
          },
          error: { code: 'TIMEOUT', message: 'Command timed out after 5000ms' },
        });
      },
    },
  });

  const result = await system.execute('Start-Sleep -Seconds 30');

  assert.equal(result.exit_code, 1);
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error_code, 'TIMEOUT');
  assert.equal(result.stderr, 'Command timed out after 5000ms');
  assert.equal(result.sandbox?.denied, true);
});

test('danger-full-access does not retain workspace path preflight restrictions', async () => {
  const calls: ShellRequest[] = [];
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, {
    shellExecutor: {
      async run(request) {
        calls.push(request);
        return completedShellResult({
          sandbox: {
            mode: 'danger-full-access',
            enforced: false,
            enforcement: 'none',
            denied: false,
            runner: 'test',
          },
        });
      },
    },
  });

  await system.execute('Set-Content E:\\outside.txt test', [], undefined, { sandboxMode: 'danger-full-access' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sandbox.mode, 'danger-full-access');
});

test('execute defaults cwd to the workspace root', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await system.execute('npm test');

  assert.match(backend.calls[0], /^cd /);
  assert.match(backend.calls[0], /npm test$/);
});

test('execute uses the invocation workspace instead of the backend default root', async () => {
  const backend = createBackend();
  const defaultWorkspace = path.resolve('E:/work/default');
  const invocationWorkspace = path.resolve('E:/work/project-a');
  const system = new LocalSystemBackend(defaultWorkspace, { backend });

  await system.execute('npm test', [], undefined, { workspaceRoot: invocationWorkspace });

  assert.match(backend.calls[0], new RegExp(escapeRegExp(invocationWorkspace)));
  assert.doesNotMatch(backend.calls[0], new RegExp(escapeRegExp(defaultWorkspace)));
});

test('writeFile writes directly when parent is the backend root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-write-root-'));
  try {
    const system = new LocalSystemBackend(root);

    await system.writeFile('a.md', 'hello');

    const target = path.join(root, 'a.md');
    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(target, 'utf8'), 'hello');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only rejects direct file writes and edits', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-read-only-root-'));
  const target = path.join(root, 'existing.txt');
  try {
    writeFileSync(target, 'before');
    const system = new LocalSystemBackend(root);
    const access = { workspaceRoot: root, sandboxMode: 'read-only' as const };

    await assert.rejects(
      () => system.writeFile('created.txt', 'blocked', access),
      /Writes are disabled in read-only mode/,
    );
    await assert.rejects(
      () => system.editFile('existing.txt', 'before', 'after', undefined, access),
      /Writes are disabled in read-only mode/,
    );

    assert.equal(existsSync(path.join(root, 'created.txt')), false);
    assert.equal(readFileSync(target, 'utf8'), 'before');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace-write rejects writes outside workspace even when the path is approved', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-workspace-write-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moke-workspace-write-outside-'));
  const target = path.join(outside, 'blocked.txt');
  try {
    const system = new LocalSystemBackend(root);
    system.approveWorkspaceRoot(outside);

    await assert.rejects(
      () => system.writeFile(target, 'blocked', {
        workspaceRoot: root,
        sandboxMode: 'workspace-write',
      }),
      /Write path must be inside workspaceRoot for workspace-write/,
    );

    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('danger-full-access allows direct file writes outside workspace', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-full-access-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moke-full-access-outside-'));
  const target = path.join(outside, 'allowed.txt');
  try {
    const system = new LocalSystemBackend(root);

    await system.writeFile(target, 'allowed', {
      workspaceRoot: root,
      sandboxMode: 'danger-full-access',
    });

    assert.equal(readFileSync(target, 'utf8'), 'allowed');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('workspace symlinks cannot escape the approved root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-symlink-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'moke-symlink-outside-'));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const system = new LocalSystemBackend(root);

    await assert.rejects(() => system.readFile('link/secret.txt'), /Path requires approval/);
    await assert.rejects(
      () => system.writeFile('link/new.txt', 'outside'),
      /Write path must be inside workspaceRoot for workspace-write/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('readFile requests approval for the exact external file', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });
  const target = path.resolve('C:/Windows/System32/drivers/etc/hosts');

  await assert.rejects(
    () => system.readFile(target),
    (error: unknown) => {
      assert.equal((error as { details?: { suggestedRoot?: string } }).details?.suggestedRoot, target);
      return true;
    },
  );
});

test('readImage detects image content and returns a data URL', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend: createBackend({ rawContent: png }) });

  const result = await system.readImage('image.bin');

  assert.equal(result.path, 'image.bin');
  assert.equal(result.mime_type, 'image/png');
  assert.equal(result.size, png.byteLength);
  assert.equal(result.data_url, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
});

test('readImage rejects unsupported binary content', async () => {
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, {
    backend: createBackend({ rawContent: Uint8Array.from([0x00, 0x01, 0x02]) }),
  });

  await assert.rejects(() => system.readImage('image.bin'), /supported PNG, JPEG, WebP, or GIF/);
});

test('execute rejects absolute command paths outside workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('copy E:\\work\\test\\moke\\a.md E:\\a.md'),
    /Command path requires approval: E:\\a\.md/,
  );
});

test('execute allows absolute command paths inside workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await system.execute('type E:\\work\\test\\moke\\a.md');

  assert.equal(backend.calls.length, 1);
});

test('execute allows absolute command paths inside approved roots', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  const approval = system.approveWorkspaceRoot('E:/notes');
  await system.execute('type E:\\notes\\a.md');

  assert.equal(approval.added, true);
  assert.equal(backend.calls.length, 1);
});

test('per-invocation roots do not leak to another session sharing the backend', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });
  const sessionARoots = ['E:/notes'];

  await system.execute('type E:\\notes\\a.md', [], undefined, { approvedRoots: sessionARoots });

  await assert.rejects(
    () => system.execute('type E:\\notes\\a.md'),
    /Command path requires approval: E:\\notes\\a\.md/,
  );
  assert.equal(backend.calls.length, 1);
});

test('execute rejects paths after revoking an approved root', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  system.approveWorkspaceRoot('E:/notes');
  system.revokeWorkspaceRoot('E:/notes');

  await assert.rejects(
    () => system.execute('type E:\\notes\\a.md'),
    /Command path requires approval: E:\\notes\\a\.md/,
  );
});

test('execute allows relative command paths inside workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await system.execute('type .\\a.md');

  assert.equal(backend.calls.length, 1);
});

test('execute does not treat URLs as workspace paths', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await system.execute('curl https://example.com/a/b');

  assert.equal(backend.calls.length, 1);
});

test('execute rejects relative command paths escaping workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('type ..\\a.md'),
    /Command relative path escapes workspace: \.\.\\a\.md/,
  );
});

test('execute resolves relative command paths from cwd', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('type ..\\..\\..\\a.md', [], { cwd: 'apps/server' }),
    /Command relative path escapes workspace: \.\.\\\.\.\\\.\.\\a\.md/,
  );
});

test('execute rejects redirect targets escaping workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('echo hello > ..\\a.md'),
    /Command relative path escapes workspace: \.\.\\a\.md|Command redirection target requires approval: \.\.\\a\.md/,
  );
});

test('execute rejects absolute redirect targets outside workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('echo hello > E:\\a.md'),
    /Command path requires approval: E:\\a\.md|Command redirection target requires approval: E:\\a\.md/,
  );
});

test('execute separates stdout and stderr for local commands', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-execute-root-'));
  try {
    const system = new LocalSystemBackend(root);
    const result = await system.execute('node', ['-e', "process.stdout.write('out'); process.stderr.write('err')"]);

    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute rejects UNC paths', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('copy a.md \\\\server\\share\\a.md'),
    /Command path requires approval: \\\\server\\share\\a\.md/,
  );
});

test('execute rejects Windows drive-relative paths', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('copy a.md E:a.md'),
    /Command path is ambiguous outside workspace: E:a\.md/,
  );
});

test('execute reports cmd-style switches as PowerShell compatibility errors on Windows', {
  skip: process.platform !== 'win32',
}, async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('del /q ".moke-browser-test\\manual-approval.txt"'),
    /Command uses cmd\.exe switch \/q with PowerShell command del/,
  );
  assert.equal(backend.calls.length, 0);
});

test('execute rejects working directory changes outside workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('cd ..; copy moke\\a.md a.md'),
    /Command changes working directory outside workspace: \.\./,
  );
});

test('execute rejects environment variable paths outside approved roots', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });
  process.env.MOKE_TEST_TEMP = path.resolve('E:/moke-temp');

  await assert.rejects(
    () => system.execute('copy a.md $env:MOKE_TEST_TEMP\\a.md'),
    /Command path uses an environment variable and requires approval: \$env:MOKE_TEST_TEMP\\a\.md/,
  );
});

test('execute allows environment variable paths inside approved roots', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });
  process.env.MOKE_TEST_WORKSPACE = workspace;

  await system.execute('copy a.md $env:MOKE_TEST_WORKSPACE\\a.md');

  assert.equal(backend.calls.length, 1);
});

test('execute rejects dynamic path builders outside workspace', async () => {
  const backend = createBackend();
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('copy a.md (Join-Path E:\\ a.md)'),
    /Command builds a path outside workspace and requires approval: E:\\/,
  );
});

test('execute respects timeoutMs', async () => {
  const backend = createBackend({ executeDelayMs: 20 });
  const workspace = path.resolve('E:/work/test/moke');
  const system = new LocalSystemBackend(workspace, { backend });

  await assert.rejects(
    () => system.execute('npm test', [], { timeoutMs: 1 }),
    /Command timed out after 1ms: npm test/,
  );
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
