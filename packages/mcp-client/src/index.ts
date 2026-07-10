import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { RiskLevel } from '../../protocol/src/index.js';

const rootConfigSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
]);

const serverConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  enabled: z.boolean().default(true),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().default(30000),
  max_output_chars: z.number().int().positive().default(20000),
  tool_risks: z.record(z.string(), z.enum(['safe', 'write', 'dangerous'])).default({}),
  disabled_tools: z.array(z.string()).default([]),
  roots: z.array(rootConfigSchema).optional(),
});

const mcpConfigSchema = z.object({
  servers: z.array(serverConfigSchema).default([]),
});

const mcpServerEntrySchema = serverConfigSchema.omit({ id: true, transport: true }).extend({
  type: z.literal('stdio').optional(),
  transport: z.literal('stdio').optional(),
});

const mcpConfigInputSchema = z.union([
  z.object({
    servers: z.array(serverConfigSchema).default([]),
  }).strict(),
  z.object({
    mcpServers: z.record(z.string(), mcpServerEntrySchema).default({}),
  }).strict(),
]);

export type McpServerConfig = z.infer<typeof serverConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpRoot = {
  uri: string;
  name?: string;
};

export type McpTool = {
  name: string;
  originalName: string;
  serverId: string;
  description: string;
  risk: RiskLevel;
  inputSchema: Record<string, unknown>;
  maxOutputChars: number;
};

type McpConnection = {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
  roots: McpRoot[];
};

export async function loadMcpConfig(path: string): Promise<McpConfig> {
  const raw = await readFile(path, 'utf8');
  return parseMcpConfigText(raw);
}

export function parseMcpConfigText(raw: string): McpConfig {
  const parsed = JSON.parse(raw) as unknown;
  return normalizeMcpConfig(mcpConfigInputSchema.parse(parsed));
}

export function createNamespacedToolName(serverId: string, toolName: string) {
  return `mcp__${safeToolSegment(serverId)}__${safeToolSegment(toolName)}`;
}

function safeToolSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'tool';
}

function normalizeMcpConfig(input: z.infer<typeof mcpConfigInputSchema>): McpConfig {
  if ('servers' in input) return mcpConfigSchema.parse(input);

  return mcpConfigSchema.parse({
    servers: Object.entries(input.mcpServers).map(([id, server]) => ({
      ...server,
      id,
      transport: 'stdio',
    })),
  });
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();

  constructor(
    private readonly config: McpConfig,
    private readonly options: { workspace?: string } = {},
  ) {}

  async connectAll() {
    const results: Array<{ serverId: string; status: 'connected' | 'skipped' | 'failed'; error?: string }> = [];

    for (const server of this.config.servers) {
      if (!server.enabled) {
        results.push({ serverId: server.id, status: 'skipped' });
        continue;
      }

      try {
        await this.connectServer(server);
        results.push({ serverId: server.id, status: 'connected' });
      } catch (error) {
        results.push({
          serverId: server.id,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  async connectServer(config: McpServerConfig): Promise<McpConnection> {
    const existing = this.connections.get(config.id);
    if (existing) return existing;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });
    const client = new Client({
      name: 'moke',
      version: '0.1.0',
    }, {
      capabilities: {
        roots: {
          listChanged: false,
        },
      },
    });
    const roots = createRoots(config, this.options.workspace);

    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots,
    }));

    let toolList;
    try {
      await client.connect(transport, { timeout: config.timeout_ms });
      toolList = await client.listTools(undefined, { timeout: config.timeout_ms });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }

    const disabledTools = new Set(config.disabled_tools);
    const tools = (toolList.tools || [])
      .filter((tool) => !disabledTools.has(tool.name))
      .map((tool) => ({
        name: createNamespacedToolName(config.id, tool.name),
        originalName: tool.name,
        serverId: config.id,
        description: tool.description || `MCP tool ${tool.name} from ${config.id}`,
        risk: config.tool_risks[tool.name] || 'safe',
        inputSchema: (tool.inputSchema || {}) as Record<string, unknown>,
        maxOutputChars: config.max_output_chars,
      }));

    const connection = {
      config,
      client,
      transport,
      tools,
      roots,
    };

    this.connections.set(config.id, connection);
    return connection;
  }

  listTools() {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }

  listRoots() {
    return [...this.connections.values()].map((connection) => ({
      serverId: connection.config.id,
      roots: connection.roots,
    }));
  }

  async callTool(namespacedName: string, input: Record<string, unknown> = {}) {
    const tool = this.findTool(namespacedName);
    const connection = this.connections.get(tool.serverId);
    if (!connection) throw new Error(`MCP server is not connected: ${tool.serverId}`);

    return connection.client.callTool(
      {
        name: tool.originalName,
        arguments: input,
      },
      undefined,
      { timeout: connection.config.timeout_ms },
    );
  }

  async close() {
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.client.close()));
    this.connections.clear();
  }

  private findTool(namespacedName: string) {
    for (const connection of this.connections.values()) {
      const tool = connection.tools.find((candidate) => candidate.name === namespacedName);
      if (tool) return tool;
    }

    throw new Error(`MCP tool not found: ${namespacedName}`);
  }
}

function createRoots(config: McpServerConfig, workspace = process.cwd()): McpRoot[] {
  const configuredRoots = config.roots?.length ? config.roots : [{ path: workspace, name: 'workspace' }];

  return configuredRoots.map((root) => {
    const path = typeof root === 'string' ? root : root.path;
    const name = typeof root === 'string' ? undefined : root.name;
    const resolvedPath = resolve(workspace, path);

    return {
      uri: pathToFileURL(resolvedPath).toString(),
      ...(name ? { name } : {}),
    };
  });
}
