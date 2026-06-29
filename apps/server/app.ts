import http from 'node:http';

import type { Run, Session } from '../../packages/protocol/src/index.js';
import {
  loadFirstEnvFile,
  resolveEnvPaths,
  resolvePath,
  resolveServerConfig,
  type ServerConfig,
} from './config/paths.js';
import { createToolRegistry, createRunManager } from './runtime/factory.js';
import { createRoutes } from './routes/index.js';
import { BrowserBridge } from './services/browser-bridge.js';
import { registerMcpTools } from './services/mcp-tools.js';
import {
  loadWorkspaceRootPermissions,
  saveWorkspaceRootPermissions,
  upsertWorkspaceRootPermission,
  type WorkspaceRootPermission,
} from './storage/permissions.js';
import { createStateSaver, loadState } from './storage/state.js';

export {
  normalizeWindowsDrivePath,
  resolveEnvPaths,
  resolvePath,
  resolvePort,
  resolveServerConfig,
} from './config/paths.js';
export type { ServerConfig } from './config/paths.js';

export type ServerApp = {
  port: number;
  server: http.Server;
  close: () => Promise<void>;
};

function closeHttpServer(server: http.Server) {
  if (!server.listening) return Promise.resolve();

  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export async function createApp(): Promise<ServerApp> {
  const initialWorkspace = resolvePath(process.env.MOKE_WORKSPACE, process.cwd(), process.cwd());
  const loadedEnvPath = loadFirstEnvFile(resolveEnvPaths(initialWorkspace));
  if (loadedEnvPath) console.log(`Loaded environment from ${loadedEnvPath}`);

  const config: ServerConfig = resolveServerConfig();
  const { mcpConfigPath, permissionsPath, port, statePath, workspace } = config;

  const sessions = new Map<string, Session>();
  const runs = new Map<string, Run>();
  const browserBridge = new BrowserBridge();
  const stateSaver = createStateSaver({ statePath, sessions, runs });
  const { system, toolRegistry } = createToolRegistry(workspace, browserBridge);
  const persistentWorkspaceRoots: WorkspaceRootPermission[] = loadWorkspaceRootPermissions(permissionsPath);
  for (const permission of persistentWorkspaceRoots) {
    system.approveWorkspaceRoot(permission.path);
  }

  loadState({ statePath, sessions, runs });

  const mcpManager = await registerMcpTools(toolRegistry, mcpConfigPath, workspace);
  const runManager = createRunManager({
    sessions,
    runs,
    toolRegistry,
    workspace,
    approveWorkspaceRoot: (root, scope) => {
      system.approveWorkspaceRoot(root);
      if (scope === 'persistent') {
        upsertWorkspaceRootPermission(persistentWorkspaceRoots, root);
        saveWorkspaceRootPermissions(permissionsPath, persistentWorkspaceRoots);
      }
    },
    onChange: stateSaver.saveStateSoon,
  });
  const server = http.createServer(
    createRoutes({
      sessions,
      runs,
      runManager,
      toolRegistry,
      browserBridge,
      onChange: stateSaver.saveStateSoon,
    }),
  );

  return {
    port,
    server,
    close: async () => {
      browserBridge.close();
      stateSaver.flush();
      await mcpManager?.close();
      await closeHttpServer(server);
    },
  };
}
