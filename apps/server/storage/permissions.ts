import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type WorkspacePermissionScope = 'once' | 'session' | 'persistent';

export type WorkspaceRootPermission = {
  path: string;
  added_at: string;
};

export type McpServerTrust = {
  server_id: string;
  fingerprint: string;
  trusted_at: string;
};

type StoredPermissions = {
  workspace_roots?: WorkspaceRootPermission[];
  trusted_mcp_servers?: McpServerTrust[];
};

function loadStoredPermissions(permissionsPath: string): StoredPermissions {
  if (!existsSync(permissionsPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(permissionsPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as StoredPermissions
      : {};
  } catch (error) {
    console.warn(`Failed to load permissions from ${permissionsPath}:`, error);
    return {};
  }
}

function saveStoredPermissions(permissionsPath: string, permissions: StoredPermissions) {
  try {
    mkdirSync(dirname(permissionsPath), { recursive: true });
    writeFileSync(permissionsPath, `${JSON.stringify(permissions, null, 2)}\n`);
  } catch (error) {
    console.warn(`Failed to save permissions to ${permissionsPath}:`, error);
  }
}

export function loadWorkspaceRootPermissions(permissionsPath: string) {
  const parsed = loadStoredPermissions(permissionsPath);
  return dedupeRoots(
    (parsed.workspace_roots || [])
      .filter((permission) => permission && typeof permission.path === 'string')
      .map((permission) => ({
        path: resolve(permission.path),
        added_at: typeof permission.added_at === 'string' ? permission.added_at : new Date().toISOString(),
      })),
  );
}

export function saveWorkspaceRootPermissions(permissionsPath: string, permissions: WorkspaceRootPermission[]) {
  const current = loadStoredPermissions(permissionsPath);
  const payload: StoredPermissions = {
    ...current,
    workspace_roots: dedupeRoots(permissions).sort((left, right) => left.path.localeCompare(right.path)),
  };
  saveStoredPermissions(permissionsPath, payload);
}

export function loadMcpServerTrusts(permissionsPath: string): McpServerTrust[] {
  const parsed = loadStoredPermissions(permissionsPath);
  return dedupeMcpServerTrusts((parsed.trusted_mcp_servers || [])
    .filter((trust) => trust
      && typeof trust.server_id === 'string'
      && typeof trust.fingerprint === 'string'
      && typeof trust.trusted_at === 'string')
    .map((trust) => ({ ...trust })));
}

export function saveMcpServerTrusts(permissionsPath: string, trusts: McpServerTrust[]) {
  const current = loadStoredPermissions(permissionsPath);
  saveStoredPermissions(permissionsPath, {
    ...current,
    trusted_mcp_servers: dedupeMcpServerTrusts(trusts)
      .sort((left, right) => left.server_id.localeCompare(right.server_id)),
  });
}

export function upsertWorkspaceRootPermission(
  permissions: WorkspaceRootPermission[],
  root: string,
  now = new Date().toISOString(),
) {
  const normalizedRoot = resolve(root);
  const existing = permissions.find((permission) => samePath(permission.path, normalizedRoot));
  if (existing) return permissions;

  permissions.push({
    path: normalizedRoot,
    added_at: now,
  });
  return permissions;
}

function dedupeRoots(permissions: WorkspaceRootPermission[]) {
  const result: WorkspaceRootPermission[] = [];
  for (const permission of permissions) {
    if (!result.some((item) => samePath(item.path, permission.path))) result.push(permission);
  }
  return result;
}

function dedupeMcpServerTrusts(trusts: McpServerTrust[]) {
  return [...new Map(trusts.map((trust) => [trust.server_id, { ...trust }])).values()];
}

function samePath(left: string, right: string) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
