import { resolve } from 'node:path';

import {
  loadWorkspaceRootPermissions,
  saveWorkspaceRootPermissions,
  upsertWorkspaceRootPermission,
  type WorkspaceRootPermission,
} from '../storage/permissions.js';

type PermissionsServiceOptions = {
  revokeWorkspaceRoot: (root: string) => void;
};

export class PermissionsService {
  private readonly workspaceRoots: WorkspaceRootPermission[];

  constructor(
    private readonly permissionsPath: string,
    private readonly options: PermissionsServiceOptions,
  ) {
    this.workspaceRoots = loadWorkspaceRootPermissions(permissionsPath);
  }

  listWorkspaceRoots() {
    return this.workspaceRoots.map((permission) => ({ ...permission }));
  }

  upsertWorkspaceRoot(root: string) {
    upsertWorkspaceRootPermission(this.workspaceRoots, root);
    saveWorkspaceRootPermissions(this.permissionsPath, this.workspaceRoots);
    return this.listWorkspaceRoots();
  }

  revokeWorkspaceRoot(root: string) {
    const normalizedRoot = resolve(root).toLowerCase();
    const index = this.workspaceRoots.findIndex((permission) => resolve(permission.path).toLowerCase() === normalizedRoot);
    if (index < 0) return false;

    this.workspaceRoots.splice(index, 1);
    this.options.revokeWorkspaceRoot(root);
    saveWorkspaceRootPermissions(this.permissionsPath, this.workspaceRoots);
    return true;
  }
}
