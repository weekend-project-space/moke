import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const serverConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  enabled: z.boolean().default(true),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().default(30000),
});

const mcpConfigSchema = z.object({
  servers: z.array(serverConfigSchema).default([]),
});

export type McpServerConfig = z.infer<typeof serverConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export type McpTool = {
  name: string;
  originalName: string;
  serverId: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type McpConnection = {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
};

export async function loadMcpConfig(path: string): Promise<McpConfig> {
  const raw = await readFile(path, 'utf8');
  return mcpConfigSchema.parse(JSON.parse(raw));
}

export function createNamespacedToolName(serverId: string, toolName: string) {
  return `mcp__${safeToolSegment(serverId)}__${safeToolSegment(toolName)}`;
}

function safeToolSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'tool';
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();

  constructor(private readonly config: McpConfig) {}

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
    });

    await withTimeout(client.connect(transport), config.timeout_ms, `MCP server ${config.id} connect timed out`);
    const toolList = await withTimeout(client.listTools(), config.timeout_ms, `MCP server ${config.id} listTools timed out`);
    const tools = (toolList.tools || []).map((tool) => ({
      name: createNamespacedToolName(config.id, tool.name),
      originalName: tool.name,
      serverId: config.id,
      description: tool.description || `MCP tool ${tool.name} from ${config.id}`,
      inputSchema: (tool.inputSchema || {}) as Record<string, unknown>,
    }));

    const connection = {
      config,
      client,
      transport,
      tools,
    };

    this.connections.set(config.id, connection);
    return connection;
  }

  listTools() {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }

  async callTool(namespacedName: string, input: Record<string, unknown> = {}) {
    const tool = this.findTool(namespacedName);
    const connection = this.connections.get(tool.serverId);
    if (!connection) throw new Error(`MCP server is not connected: ${tool.serverId}`);

    return withTimeout(
      connection.client.callTool({
        name: tool.originalName,
        arguments: input,
      }),
      connection.config.timeout_ms,
      `MCP tool ${namespacedName} timed out`,
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
