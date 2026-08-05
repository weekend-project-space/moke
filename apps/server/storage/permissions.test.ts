import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  loadMcpServerTrusts,
  loadWorkspaceRootPermissions,
  saveMcpServerTrusts,
  saveWorkspaceRootPermissions,
  upsertWorkspaceRootPermission,
  type WorkspaceRootPermission,
} from './permissions.js';

test('workspace root permissions persist and load normalized roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moke-permissions-'));
  try {
    const permissionsPath = join(dir, 'permissions.json');
    const permissions: WorkspaceRootPermission[] = [];

    upsertWorkspaceRootPermission(permissions, join(dir, 'notes'), '2026-06-27T00:00:00.000Z');
    saveWorkspaceRootPermissions(permissionsPath, permissions);

    assert.deepEqual(loadWorkspaceRootPermissions(permissionsPath), [
      {
        path: resolve(dir, 'notes'),
        added_at: '2026-06-27T00:00:00.000Z',
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace root permissions are deduped case-insensitively', () => {
  const permissions: WorkspaceRootPermission[] = [];

  upsertWorkspaceRootPermission(permissions, 'E:/Notes', '2026-06-27T00:00:00.000Z');
  upsertWorkspaceRootPermission(permissions, 'e:/notes', '2026-06-27T00:00:01.000Z');

  assert.equal(permissions.length, 1);
});

test('saveWorkspaceRootPermissions writes stable JSON shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moke-permissions-'));
  try {
    const permissionsPath = join(dir, 'permissions.json');
    saveWorkspaceRootPermissions(permissionsPath, [
      {
        path: resolve(dir, 'notes'),
        added_at: '2026-06-27T00:00:00.000Z',
      },
    ]);

    const parsed = JSON.parse(readFileSync(permissionsPath, 'utf8'));
    assert.deepEqual(Object.keys(parsed), ['workspace_roots']);
    assert.equal(parsed.workspace_roots[0].path, resolve(dir, 'notes'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace roots and MCP server trusts preserve each other', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moke-permissions-'));
  try {
    const permissionsPath = join(dir, 'permissions.json');
    saveMcpServerTrusts(permissionsPath, [{
      server_id: 'local',
      fingerprint: 'abc123',
      trusted_at: '2026-08-05T00:00:00.000Z',
    }]);
    saveWorkspaceRootPermissions(permissionsPath, [{
      path: resolve(dir, 'notes'),
      added_at: '2026-08-05T00:00:01.000Z',
    }]);

    assert.deepEqual(loadMcpServerTrusts(permissionsPath), [{
      server_id: 'local',
      fingerprint: 'abc123',
      trusted_at: '2026-08-05T00:00:00.000Z',
    }]);
    assert.equal(loadWorkspaceRootPermissions(permissionsPath)[0]?.path, resolve(dir, 'notes'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
