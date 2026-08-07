import { existsSync } from 'node:fs';

import { z } from 'zod';

import { ToolExecutionError, type RuntimeTool } from '@moke/agent-runtime';
import {
  createMcpServerFingerprint,
  McpWorkspacePool,
  loadMcpConfig,
  type McpServerConfig,
  type McpTool,
} from '@moke/mcp-client';

function describeMcpTool(tool: McpTool) {
  const schema = JSON.stringify(tool.inputSchema);
  const schemaHint = schema && schema !== '{}' ? ` Input schema: ${schema.slice(0, 1200)}` : '';
  return `${tool.description} MCP server: ${tool.serverId}.${schemaHint}`;
}

function normalizeMcpResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return { content: result };

  const candidate = result as Record<string, unknown>;
  return {
    content: candidate.content,
    structuredContent: candidate.structuredContent,
    isError: candidate.isError,
    _meta: candidate._meta,
  };
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema.type;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;

  if (enumValues?.length) {
    if (enumValues.length === 1) return z.literal(enumValues[0]);
    return z.union(enumValues.map((value) => z.literal(value)) as [z.ZodLiteral<any>, z.ZodLiteral<any>, ...z.ZodLiteral<any>[]]);
  }

  if (type === 'string') return z.string();
  if (type === 'number') return z.number();
  if (type === 'integer') return z.number().int();
  if (type === 'boolean') return z.boolean();
  if (type === 'array') {
    const items = schema.items && typeof schema.items === 'object' ? (schema.items as Record<string, unknown>) : {};
    return z.array(jsonSchemaToZod(items));
  }

  if (type === 'object' || schema.properties) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
    const shape: Record<string, z.ZodType> = {};

    for (const [key, value] of Object.entries(properties)) {
      const fieldSchema = value && typeof value === 'object' ? jsonSchemaToZod(value as Record<string, unknown>) : z.unknown();
      shape[key] = required.has(key) ? fieldSchema : fieldSchema.optional();
    }

    return z.object(shape).passthrough();
  }

  return z.object({}).passthrough();
}

function normalizeMcpError(error: unknown, tool: McpTool) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.toLowerCase().includes('timed out') ? 'MCP_TOOL_TIMEOUT' : 'MCP_TOOL_FAILED';

  return {
    error: {
      code,
      message,
      tool: tool.name,
      original_name: tool.originalName,
      server_id: tool.serverId,
    },
  };
}

function truncateMcpOutput(output: Record<string, unknown>, maxChars: number) {
  const jsonOutput = JSON.stringify(output);
  if (jsonOutput.length <= maxChars) return output;

  return {
    content: jsonOutput.slice(0, maxChars),
    truncated: true,
    max_output_chars: maxChars,
  };
}

export async function createMcpToolRuntime(
  mcpConfigPath: string,
  workspace: string,
  isServerTrusted: (serverId: string, fingerprint: string) => boolean,
) {
  if (!existsSync(mcpConfigPath)) return undefined;

  try {
    const config = await loadMcpConfig(mcpConfigPath);
    const mcpManager = new McpWorkspacePool(config, {
      workspace,
      isServerTrusted: (server) => isTrusted(server, isServerTrusted),
    });

    return {
      async getTools(toolWorkspace: string): Promise<RuntimeTool[]> {
        const tools = await mcpManager.getTools(toolWorkspace);
        for (const result of mcpManager.listConnectionResults(toolWorkspace)) {
          if (result.status === 'failed') {
            console.warn(`MCP server ${result.serverId} failed in ${toolWorkspace}: ${result.error}`);
          }
        }
        return tools.map((tool) => createRuntimeMcpTool(mcpManager, tool));
      },
      close: () => mcpManager.close(),
    };
  } catch (error) {
    console.warn(`Failed to load MCP config from ${mcpConfigPath}:`, error);
    return undefined;
  }
}

async function callMcpTool(
  manager: McpWorkspacePool,
  tool: McpTool,
  input: Record<string, unknown>,
  workspace?: string,
) {
  try {
    const result = await manager.callTool(tool.name, input, workspace);
    return truncateMcpOutput(normalizeMcpResult(result), tool.maxOutputChars);
  } catch (error) {
    throw new ToolExecutionError(`MCP tool failed: ${tool.name}`, normalizeMcpError(error, tool));
  }
}

function isTrusted(
  server: McpServerConfig,
  isServerTrusted: (serverId: string, fingerprint: string) => boolean,
) {
  return isServerTrusted(server.id, createMcpServerFingerprint(server));
}

function createRuntimeMcpTool(mcpManager: McpWorkspacePool, mcpTool: McpTool): RuntimeTool {
  return {
    name: mcpTool.name,
    original_name: mcpTool.originalName,
    description: describeMcpTool(mcpTool),
    source: {
      type: 'mcp',
      server_id: mcpTool.serverId,
    },
    approval: mcpTool.readOnly ? 'none' : 'required',
    input_schema: mcpTool.inputSchema,
    schema: jsonSchemaToZod(mcpTool.inputSchema),
    async prepare(input, context) {
      const toolInput = input && typeof input === 'object' ? input : {};
      const preparedWorkspace = context.workspace;
      return {
        approvalInput: {
          ...(toolInput as Record<string, unknown>),
          __moke_workspace: preparedWorkspace,
        },
        execute: () => callMcpTool(mcpManager, mcpTool, toolInput as Record<string, unknown>, preparedWorkspace),
      };
    },
    async handler(input, context) {
      const toolInput = input && typeof input === 'object' ? input : {};
      return callMcpTool(mcpManager, mcpTool, toolInput as Record<string, unknown>, context.workspace);
    },
  };
}
