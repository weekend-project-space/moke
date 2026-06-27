import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type WorkspacePermissionScope = 'once' | 'session' | 'persistent';

export type WorkspaceRootPermission = {
  path: string;
  added_at: string;
};

type StoredPermissions = {
  workspace_roots?: WorkspaceRootPermission[];
};

export function loadWorkspaceRootPermissions(permissionsPath: string) {
  if (!existsSync(permissionsPath)) return [];

  try {
    const parsed = JSON.parse(readFileSync(permissionsPath, 'utf8')) as Partial<StoredPermissions>;
    return dedupeRoots(
      (parsed.workspace_roots || [])
        .map((permission) => ({
          path: resolve(permission.path),
          added_at: typeof permission.added_at === 'string' ? permission.added_at : new Date().toISOString(),
        }))
        .filter((permission) => permission.path),
    );
  } catch (error) {
    console.warn(`Failed to load permissions from ${permissionsPath}:`, error);
    return [];
  }
}

export function saveWorkspaceRootPermissions(permissionsPath: string, permissions: WorkspaceRootPermission[]) {
  const payload: StoredPermissions = {
    workspace_roots: dedupeRoots(permissions).sort((left, right) => left.path.localeCompare(right.path)),
  };

  try {
    mkdirSync(dirname(permissionsPath), { recursive: true });
    writeFileSync(permissionsPath, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    console.warn(`Failed to save permissions to ${permissionsPath}:`, error);
  }
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

function samePath(left: string, right: string) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
