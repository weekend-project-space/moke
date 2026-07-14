import http from 'node:http';

import type { RuntimeRun } from '../../packages/agent-runtime/src/index.js';
import type { Session } from '../../packages/protocol/src/index.js';
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
import { McpSettingsService } from './services/mcp-settings-service.js';
import { registerMcpTools } from './services/mcp-tools.js';
import { PermissionsService } from './services/permissions-service.js';
import { SettingsService } from './services/settings-service.js';
import { SkillSettingsService } from './services/skill-settings-service.js';
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
  const { mcpConfigPath, permissionsPath, port, settingsPath, statePath, workspace } = config;

  const sessions = new Map<string, Session>();
  const runs = new Map<string, RuntimeRun>();
  const browserBridge = new BrowserBridge();
  const mcpSettingsService = new McpSettingsService(mcpConfigPath);
  const settingsService = new SettingsService(settingsPath);
  const skillSettingsService = new SkillSettingsService(workspace);
  const stateSaver = createStateSaver({ statePath, sessions });
  const { system, toolRegistry } = createToolRegistry(workspace, browserBridge);
  const permissionsService = new PermissionsService(permissionsPath, {
    revokeWorkspaceRoot: (root) => system.revokeWorkspaceRoot(root),
  });
  for (const permission of permissionsService.listWorkspaceRoots()) {
    system.approveWorkspaceRoot(permission.path);
  }

  loadState({ statePath, sessions });

  const mcpManager = await registerMcpTools(toolRegistry, mcpConfigPath, workspace);
  const runManager = createRunManager({
    sessions,
    runs,
    toolRegistry,
    workspace,
    approveWorkspaceRoot: (root, scope) => {
      const approval = system.approveWorkspaceRoot(root);
      if (scope === 'once') {
        return approval.added ? () => system.revokeWorkspaceRoot(root) : undefined;
      }
      if (scope === 'persistent') {
        permissionsService.upsertWorkspaceRoot(root);
      }
    },
    getModelSettings: () => settingsService.getModelSettings(),
    onChange: stateSaver.saveStateSoon,
  });

  const server = http.createServer(
    createRoutes({
      sessions,
      runs,
      runManager,
      toolRegistry,
      browserBridge,
      mcpSettingsService,
      permissionsService,
      settingsService,
      skillSettingsService,
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
