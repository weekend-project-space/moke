import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createMcpServerFingerprint, McpWorkspacePool, parseMcpConfigText } from './index.js';

test('MCP config defaults read_only_tools and accepts explicit original tool names', () => {
  const config = parseMcpConfigText(JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'node',
        args: ['server.js'],
        read_only_tools: ['read_file'],
        disabled_tools: ['delete_file'],
      },
    },
  }));

  assert.deepEqual(config.servers[0]?.read_only_tools, ['read_file']);
  assert.deepEqual(config.servers[0]?.disabled_tools, ['delete_file']);
});

test('MCP config defaults read_only_tools to an empty list', () => {
  const config = parseMcpConfigText(JSON.stringify({
    servers: [{ id: 'local', transport: 'stdio', command: 'node' }],
  }));

  assert.deepEqual(config.servers[0]?.read_only_tools, []);
});

test('MCP server fingerprint ignores enabled state and changes with executable config', () => {
  const first = parseMcpConfigText(JSON.stringify({
    servers: [{ id: 'local', enabled: true, transport: 'stdio', command: 'node', args: ['server.js'] }],
  })).servers[0]!;
  const disabled = parseMcpConfigText(JSON.stringify({
    servers: [{ id: 'local', enabled: false, transport: 'stdio', command: 'node', args: ['server.js'] }],
  })).servers[0]!;
  const changed = parseMcpConfigText(JSON.stringify({
    servers: [{ id: 'local', enabled: true, transport: 'stdio', command: 'node', args: ['other.js'] }],
  })).servers[0]!;

  assert.equal(createMcpServerFingerprint(first), createMcpServerFingerprint(disabled));
  assert.notEqual(createMcpServerFingerprint(first), createMcpServerFingerprint(changed));
});

test('MCP workspace pool does not start an untrusted server', async () => {
  const pool = new McpWorkspacePool(parseMcpConfigText(JSON.stringify({
    servers: [{ id: 'blocked', transport: 'stdio', command: 'command-that-must-not-run' }],
  })), {
    isServerTrusted: () => false,
  });

  try {
    assert.deepEqual(await pool.getTools(), []);
    assert.deepEqual(pool.listConnectionResults(), [{ serverId: 'blocked', status: 'untrusted' }]);
  } finally {
    await pool.close();
  }
});

test('MCP workspace pool isolates cwd and roots for concurrent session workspaces', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.moke-mcp-test-'));
  const workspaceA = join(directory, 'workspace-a');
  const workspaceB = join(directory, 'workspace-b');
  const serverPath = join(directory, 'server.mjs');
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
  writeFileSync(serverPath, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'workspace-fixture', version: '1.0.0' });
const workspaceName = process.cwd().endsWith('workspace-a')
  ? 'workspace_a'
  : process.cwd().endsWith('workspace-b')
    ? 'workspace_b'
    : 'workspace_default';
server.registerTool(workspaceName, { description: 'Return process workspace', inputSchema: {} }, async () => {
  const roots = await server.server.listRoots();
  return { content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), roots: roots.roots }) }] };
});
await server.connect(new StdioServerTransport());
`, 'utf8');

  const pool = new McpWorkspacePool(parseMcpConfigText(JSON.stringify({
    servers: [{
      id: 'fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      timeout_ms: 5_000,
    }],
  })), { workspace: directory });

  try {
    await pool.connectAll();
    const [toolsA, toolsB] = await Promise.all([
      pool.getTools(workspaceA),
      pool.getTools(workspaceB),
    ]);
    assert.deepEqual(toolsA.map((tool) => tool.name), ['mcp__fixture__workspace_a']);
    assert.deepEqual(toolsB.map((tool) => tool.name), ['mcp__fixture__workspace_b']);
    const [resultA, resultB] = await Promise.all([
      pool.callTool('mcp__fixture__workspace_a', {}, workspaceA),
      pool.callTool('mcp__fixture__workspace_b', {}, workspaceB),
    ]);
    assert.deepEqual(readWorkspaceInfo(resultA), {
      cwd: resolve(workspaceA),
      roots: [{ uri: pathToFileURL(resolve(workspaceA)).toString(), name: 'workspace' }],
    });
    assert.deepEqual(readWorkspaceInfo(resultB), {
      cwd: resolve(workspaceB),
      roots: [{ uri: pathToFileURL(resolve(workspaceB)).toString(), name: 'workspace' }],
    });
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function readWorkspaceInfo(result: unknown) {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === 'text')?.text;
  assert.ok(text);
  return JSON.parse(text) as { cwd: string; roots: Array<{ uri: string; name?: string }> };
}
