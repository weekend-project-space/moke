import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { McpSettingsError, McpSettingsService } from './mcp-settings-service.js';
import { PermissionsService } from './permissions-service.js';

test('MCP settings trust is bound to the current server configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-mcp-settings-'));
  try {
    const configPath = join(directory, 'mcp.json');
    const permissions = new PermissionsService(join(directory, 'permissions.json'), {
      revokeWorkspaceRoot: () => undefined,
    });
    const service = new McpSettingsService(configPath, permissions);
    writeFileSync(configPath, config('server.js'), 'utf8');

    assert.equal(service.get().servers[0]?.trusted, false);
    assert.equal(service.trust('local'), true);
    assert.equal(service.get().servers[0]?.trusted, true);

    writeFileSync(configPath, config('changed.js'), 'utf8');
    assert.equal(service.get().servers[0]?.trusted, false);
    assert.equal(service.revokeTrust('local'), true);
    assert.equal(service.revokeTrust('local'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP settings retain restart state after trusting a newly saved config', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-mcp-settings-'));
  try {
    const configPath = join(directory, 'mcp.json');
    const permissions = new PermissionsService(join(directory, 'permissions.json'), {
      revokeWorkspaceRoot: () => undefined,
    });
    const service = new McpSettingsService(configPath, permissions);

    assert.equal(service.save({ raw: config('server.js') }).restart_required, true);
    assert.equal(service.trust('local'), true);
    assert.equal(service.get().restart_required, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP settings manage servers without requiring raw JSON edits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-mcp-settings-'));
  try {
    const configPath = join(directory, 'mcp.json');
    const permissions = new PermissionsService(join(directory, 'permissions.json'), {
      revokeWorkspaceRoot: () => undefined,
    });
    const service = new McpSettingsService(configPath, permissions);

    const added = service.addServer({ id: 'files', command: 'node', args: ['server.js'] });
    assert.equal(added.servers[0]?.enabled, true);
    assert.equal(added.servers[0]?.trusted, false);
    assert.deepEqual(added.servers[0]?.args, ['server.js']);
    assert.throws(
      () => service.addServer({ id: 'files', command: 'node', args: [] }),
      (error: unknown) => error instanceof McpSettingsError && error.code === 'MCP_SERVER_EXISTS',
    );

    assert.equal(service.trust('files'), true);
    assert.equal(service.get().servers[0]?.trusted, true);
    const updated = service.updateServer('files', { command: 'npx', args: ['-y', 'server-package'] });
    assert.equal(updated.servers[0]?.command, 'npx');
    assert.equal(updated.servers[0]?.trusted, false);

    assert.equal(service.setServerEnabled('files', false).servers[0]?.enabled, false);
    assert.equal(service.removeServer('files').servers.length, 0);
    assert.throws(
      () => service.removeServer('missing'),
      (error: unknown) => error instanceof McpSettingsError && error.code === 'MCP_SERVER_NOT_FOUND',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function config(script: string) {
  return JSON.stringify({
    mcpServers: {
      local: {
        command: 'node',
        args: [script],
      },
    },
  });
}
