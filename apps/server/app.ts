import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

import {
  ReactAgent,
  RunManager,
  ToolRegistry,
  createAskUserTool,
  createReadFileTool,
  createSearchTool,
} from '../../packages/agent-runtime/src/index.js';
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
  const stateSaver = createStateSaver({ statePath, sessions, runs });
  const toolRegistry = new ToolRegistry()
    .register(createSearchTool())
    .register(createReadFileTool())
    .register(createAskUserTool());

  loadState({ statePath, sessions, runs });

  const mcpManager = await registerMcpTools(toolRegistry, mcpConfigPath, workspace);
  const runManager = new RunManager({
    sessions,
    runs,
    agent: new ReactAgent(),
    toolRegistry,
    workspace,
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
