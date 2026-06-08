import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

import {
  type ExecutableSystemBackend,
  ReactAgent,
  RunManager,
  ToolRegistry,
} from '../../packages/agent-runtime/src/index.js';
import {
  createEditFileTool,
  createExecuteTool,
  createGlobTool,
  createGrepTool,
  createLsTool,
  createReadFileTool,
  createSearchTool,
  createWriteFileTool,
  LocalSystemBackend,
} from '../../packages/agent-tools/src/index.js';
import {
  ContentManager,
  createListSkillsTool,
  createReadSkillTool,
  SkillLoader,
} from '../../packages/agent-skills/src/index.js';
import type { Run, Session } from '../../packages/protocol/src/index.js';
import { registerMcpTools } from './mcp-tools.js';
import { createRoutes } from './routes.js';
import { createStateSaver, loadState } from './state.js';

export type ServerApp = {
  port: number;
  server: http.Server;
  close: () => Promise<void>;
};

export async function createApp(): Promise<ServerApp> {
  const root = new URL('../..', import.meta.url).pathname;
  const envPath = join(root, '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }

  const port = Number(process.env.PORT || 4010);
  const statePath = process.env.MOKE_STATE_PATH || join(root, '.moke/state.json');
  const mcpConfigPath = process.env.MOKE_MCP_CONFIG || join(root, '.moke/mcp.json');
  const sessions = new Map<string, Session>();
  const runs = new Map<string, Run>();
  const workspace = root;
  const system = new LocalSystemBackend(workspace);
  const skillLoader = new SkillLoader(workspace);
  const stateSaver = createStateSaver({ statePath, sessions, runs });
  const toolRegistry = new ToolRegistry()
    .register(createListSkillsTool(skillLoader))
    .register(createReadSkillTool(skillLoader))
    .register(createLsTool(system))
    .register(createGlobTool(system))
    .register(createGrepTool(system))
    .register(createSearchTool(system))
    .register(createReadFileTool(system))
    .register(createWriteFileTool(system))
    .register(createEditFileTool(system));
  if (isExecutableSystemBackend(system)) {
    toolRegistry.register(createExecuteTool(system));
  }

  loadState({ statePath, sessions, runs });

  const mcpManager = await registerMcpTools(toolRegistry, mcpConfigPath, workspace);
  const runManager = new RunManager({
    sessions,
    runs,
    agent: new ReactAgent(),
    toolRegistry,
    workspace,
    createSkillContentManager: () => new ContentManager(),
    onChange: stateSaver.saveStateSoon,
  });
  const server = http.createServer(
    createRoutes({
      sessions,
      runs,
      runManager,
      toolRegistry,
      onChange: stateSaver.saveStateSoon,
    }),
  );

  return {
    port,
    server,
    close: async () => {
      stateSaver.flush();
      await mcpManager?.close();
    },
  };
}

function isExecutableSystemBackend(system: unknown): system is ExecutableSystemBackend {
  return typeof system === 'object' && system !== null && 'execute' in system;
}
