import { resolve } from 'node:path';

import {
  loadMcpServerTrusts,
  loadWorkspaceRootPermissions,
  saveMcpServerTrusts,
  saveWorkspaceRootPermissions,
  upsertWorkspaceRootPermission,
  type McpServerTrust,
  type WorkspaceRootPermission,
} from '../storage/permissions.js';

type PermissionsServiceOptions = {
  revokeWorkspaceRoot: (root: string) => void;
};

export class PermissionsService {
  private readonly workspaceRoots: WorkspaceRootPermission[];
  private readonly mcpServerTrusts: McpServerTrust[];

  constructor(
    private readonly permissionsPath: string,
    private readonly options: PermissionsServiceOptions,
  ) {
    this.workspaceRoots = loadWorkspaceRootPermissions(permissionsPath);
    this.mcpServerTrusts = loadMcpServerTrusts(permissionsPath);
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

  isMcpServerTrusted(serverId: string, fingerprint: string) {
    return this.mcpServerTrusts.some(
      (trust) => trust.server_id === serverId && trust.fingerprint === fingerprint,
    );
  }

  trustMcpServer(serverId: string, fingerprint: string) {
    const existing = this.mcpServerTrusts.find((trust) => trust.server_id === serverId);
    const trust = {
      server_id: serverId,
      fingerprint,
      trusted_at: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, trust);
    else this.mcpServerTrusts.push(trust);
    saveMcpServerTrusts(this.permissionsPath, this.mcpServerTrusts);
    return { ...trust };
  }

  revokeMcpServerTrust(serverId: string) {
    const index = this.mcpServerTrusts.findIndex((trust) => trust.server_id === serverId);
    if (index < 0) return false;
    this.mcpServerTrusts.splice(index, 1);
    saveMcpServerTrusts(this.permissionsPath, this.mcpServerTrusts);
    return true;
  }
}
