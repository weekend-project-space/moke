import { existsSync } from 'node:fs';
import http from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';

import { ReActAgent } from '../../packages/agent-re-act/src/index.js';
import { RunManager, ToolRegistry } from '../../packages/agent-runtime/src/index.js';
import { LocalSystemBackend, registerAgentTools } from '../../packages/agent-tools/src/index.js';
import { registerBrowserTools } from '../../packages/browser-tools/src/index.js';
import {
  ContentManager,
  createListSkillsTool,
  createReadSkillTool,
  SkillLoader,
} from '../../packages/agent-skills/src/index.js';
import type { Run, Session } from '../../packages/protocol/src/index.js';
import { BrowserBridge, BrowserBridgeBackend } from './browser-bridge.js';
import { registerMcpTools } from './mcp-tools.js';
import {
  loadWorkspaceRootPermissions,
  saveWorkspaceRootPermissions,
  upsertWorkspaceRootPermission,
  type WorkspaceRootPermission,
} from './permissions.js';
import { createRoutes } from './routes.js';
import { createStateSaver, loadState } from './state.js';

export type ServerApp = {
  port: number;
  server: http.Server;
  close: () => Promise<void>;
};

export type ServerConfig = {
  envPaths: string[];
  mcpConfigPath: string;
  permissionsPath: string;
  port: number;
  statePath: string;
  workspace: string;
};

export function normalizeWindowsDrivePath(value: string) {
  // Tauri/Windows can hand Node paths like "\E:\..." which node:path treats as root-relative.
  return process.platform === 'win32' ? value.replace(/^[/\\]+([a-zA-Z]:[/\\])/, '$1') : value;
}

export function resolvePath(value: string | undefined, basePath: string, fallback: string) {
  const raw = normalizeWindowsDrivePath((value || fallback).trim());
  return isAbsolute(raw) ? resolve(raw) : resolve(basePath, raw);
}

export function resolvePort(value: string | undefined) {
  const port = Number(value || 4010);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;

  console.warn(`Invalid PORT value "${value}", falling back to 4010.`);
  return 4010;
}

export function resolveServerConfig(): ServerConfig {
  const workspace = resolvePath(process.env.MOKE_WORKSPACE, process.cwd(), process.cwd());

  return {
    envPaths: resolveEnvPaths(workspace),
    mcpConfigPath: resolvePath(process.env.MOKE_MCP_CONFIG, workspace, join('.moke', 'mcp.json')),
    permissionsPath: resolvePath(process.env.MOKE_PERMISSIONS_PATH, workspace, join('.moke', 'permissions.json')),
    port: resolvePort(process.env.PORT),
    statePath: resolvePath(process.env.MOKE_STATE_PATH, workspace, join('.moke', 'state.json')),
    workspace,
  };
}

export function resolveEnvPaths(workspace: string) {
  return [
    process.env.MOKE_ENV_PATH ? resolvePath(process.env.MOKE_ENV_PATH, workspace, '') : '',
    join(workspace, '.env'),
  ].filter(Boolean);
}

function loadFirstEnvFile(envPaths: string[]) {
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      return envPath;
    }
  }

  return '';
}

function createToolRegistry(workspace: string, browserBridge: BrowserBridge) {
  const system = new LocalSystemBackend(workspace);
  const browserBackend = new BrowserBridgeBackend(browserBridge);
  const skillLoader = new SkillLoader(workspace);
  const toolRegistry = new ToolRegistry()
    .register(createListSkillsTool(skillLoader))
    .register(createReadSkillTool(skillLoader));

  registerAgentTools(toolRegistry, system);
  registerBrowserTools(toolRegistry, browserBackend);

  return { system, toolRegistry };
}

function createRunManager(input: {
  runs: Map<string, Run>;
  sessions: Map<string, Session>;
  toolRegistry: ToolRegistry;
  workspace: string;
  approveWorkspaceRoot: (root: string, scope: 'once' | 'session' | 'persistent') => void;
  onChange: () => void;
}) {
  return new RunManager({
    sessions: input.sessions,
    runs: input.runs,
    agent: new ReActAgent(),
    toolRegistry: input.toolRegistry,
    workspace: input.workspace,
    createSkillContentManager: () => new ContentManager(),
    approveWorkspaceRoot: input.approveWorkspaceRoot,
    onChange: input.onChange,
  });
}

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

  const { mcpConfigPath, permissionsPath, port, statePath, workspace } = resolveServerConfig();

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
