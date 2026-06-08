import { existsSync } from 'node:fs';

import { z } from 'zod';

import { ToolExecutionError, type ToolRegistry } from '../../packages/agent-runtime/src/index.js';
import { McpManager, loadMcpConfig, type McpTool } from '../../packages/mcp-client/src/index.js';

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

export async function registerMcpTools(toolRegistry: ToolRegistry, mcpConfigPath: string, workspace: string) {
  if (!existsSync(mcpConfigPath)) return undefined;

  try {
    const config = await loadMcpConfig(mcpConfigPath);
    const mcpManager = new McpManager(config, { workspace });
    const results = await mcpManager.connectAll();

    for (const result of results) {
      if (result.status === 'failed') {
        console.warn(`MCP server ${result.serverId} failed: ${result.error}`);
      }
    }

    for (const mcpTool of mcpManager.listTools()) {
      toolRegistry.register({
        name: mcpTool.name,
        original_name: mcpTool.originalName,
        description: describeMcpTool(mcpTool),
        risk: mcpTool.risk,
        source: {
          type: 'mcp',
          server_id: mcpTool.serverId,
        },
        input_schema: mcpTool.inputSchema,
        schema: jsonSchemaToZod(mcpTool.inputSchema),
        async handler(input) {
          if (mcpTool.risk !== 'safe') {
            throw new ToolExecutionError(`MCP tool is not allowed without approval: ${mcpTool.name}`, {
              error: {
                code: 'TOOL_NOT_ALLOWED',
                message: `MCP tool is not allowed without approval: ${mcpTool.name}`,
                tool: mcpTool.name,
                original_name: mcpTool.originalName,
                server_id: mcpTool.serverId,
                risk: mcpTool.risk,
              },
            });
          }

          const toolInput = input && typeof input === 'object' ? input : {};
          try {
            const result = await mcpManager.callTool(mcpTool.name, toolInput as Record<string, unknown>);
            return truncateMcpOutput(normalizeMcpResult(result), mcpTool.maxOutputChars);
          } catch (error) {
            throw new ToolExecutionError(`MCP tool failed: ${mcpTool.name}`, normalizeMcpError(error, mcpTool));
          }
        },
      });
    }

    console.log(`Registered ${mcpManager.listTools().length} MCP tools from ${mcpConfigPath}`);
    return mcpManager;
  } catch (error) {
    console.warn(`Failed to load MCP config from ${mcpConfigPath}:`, error);
    return undefined;
  }
}
