import { z } from 'zod';

import type { RiskLevel } from '../../protocol/src/index.js';
import type { ToolContext } from './tool-context.js';
import { isPathRequiresApprovalError } from './workspace-approval.js';

export type RuntimeTool<TInput extends z.ZodType = z.ZodType> = {
  name: string;
  original_name?: string;
  description: string;
  risk: RiskLevel;
  source?: {
    type: 'local' | 'mcp';
    server_id?: string;
  };
  input_schema?: Record<string, unknown>;
  schema: TInput;
  handler: (input: z.infer<TInput>, context: ToolContext) => Promise<Record<string, unknown>>;
};

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly output: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  register(tool: RuntimeTool) {
    this.tools.set(tool.name, tool);
    return this;
  }

  list() {
    return [...this.tools.values()].map(({ handler, ...tool }) => tool);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  async execute(name: string, input: unknown, context: ToolContext) {
    const tool = this.get(name);
    if (!tool) {
      throw new ToolExecutionError(`Tool not found: ${name}`, {
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Tool not found: ${name}`,
          tool: name,
        },
      });
    }

    const parsedInput = parseToolInput(tool, input);
    const normalizedInput = toRecord(parsedInput);
    const nextContext = {
      ...context,
      currentToolCall: {
        callId: context.currentToolCall?.callId || '',
        tool: name,
        input: normalizedInput,
        risk: tool.risk,
      },
    };

    try {
      return await tool.handler(parsedInput, nextContext);
    } catch (error) {
      if (!isPathRequiresApprovalError(error) || !context.approveWorkspacePath) throw error;

      const decision = await context.approveWorkspacePath({
        tool: name,
        input: normalizedInput,
        risk: tool.risk,
        source: tool.source,
        callId: context.currentToolCall?.callId,
        path: error.details.path,
        suggestedRoot: error.details.suggestedRoot,
        reason: error.details.reason,
      });
      if (!decision.approved) {
        throw new ToolExecutionError(decision.message || `Workspace path access rejected: ${error.details.path}`, {
          error: {
            code: 'PATH_ACCESS_REJECTED',
            message: decision.message || 'User rejected workspace path access',
            tool: name,
            path: error.details.path,
            suggested_root: error.details.suggestedRoot,
          },
        });
      }

      try {
        return await tool.handler(parsedInput, nextContext);
      } finally {
        decision.cleanup?.();
      }
    }
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseToolInput(tool: RuntimeTool, input: unknown) {
  const result = tool.schema.safeParse(input);
  if (result.success) return result.data;

  throw new ToolExecutionError(`Tool input invalid: ${tool.name}`, {
    error: {
      code: tool.source?.type === 'mcp' ? 'MCP_TOOL_INPUT_INVALID' : 'TOOL_INPUT_INVALID',
      message: z.prettifyError(result.error),
      tool: tool.name,
      server_id: tool.source?.server_id,
    },
  });
}
