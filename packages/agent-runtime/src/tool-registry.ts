import { z } from 'zod';

import type { RuntimeContextItem, ToolContext } from './tool-context.js';
import { isPathRequiresApprovalError } from './workspace-approval.js';

export type RuntimeToolResult = {
  type: 'runtime_tool_result';
  publicOutput: Record<string, unknown>;
  modelOutput?: unknown;
  context?: RuntimeContextItem[];
};

export type RuntimeToolOutput = Record<string, unknown> | RuntimeToolResult;

export type RuntimeTool<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends RuntimeToolOutput = Record<string, unknown>,
> = {
  name: string;
  original_name?: string;
  description: string;
  source?: {
    type: 'local' | 'mcp';
    server_id?: string;
  };
  input_schema?: Record<string, unknown>;
  schema: TInput;
  handler: (input: z.infer<TInput>, context: ToolContext) => Promise<TOutput>;
};

export function createRuntimeToolResult(input: Omit<RuntimeToolResult, 'type'>): RuntimeToolResult {
  return { type: 'runtime_tool_result', ...input };
}

export function normalizeRuntimeToolResult(output: RuntimeToolOutput): {
  publicOutput: Record<string, unknown>;
  modelOutput: unknown;
  context: RuntimeContextItem[];
} {
  if (isRuntimeToolResult(output)) {
    return {
      publicOutput: output.publicOutput,
      modelOutput: output.modelOutput ?? output.publicOutput,
      context: output.context || [],
    };
  }

  return {
    publicOutput: output,
    modelOutput: output,
    context: [] as RuntimeContextItem[],
  };
}

function isRuntimeToolResult(output: RuntimeToolOutput): output is RuntimeToolResult {
  return output.type === 'runtime_tool_result'
    && output.publicOutput !== null
    && typeof output.publicOutput === 'object'
    && !Array.isArray(output.publicOutput);
}

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
  private readonly tools = new Map<string, RuntimeTool<z.ZodType, RuntimeToolOutput>>();

  register<TInput extends z.ZodType, TOutput extends RuntimeToolOutput>(tool: RuntimeTool<TInput, TOutput>) {
    this.tools.set(tool.name, tool as RuntimeTool<z.ZodType, RuntimeToolOutput>);
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
      },
    };

    try {
      return await tool.handler(parsedInput, nextContext);
    } catch (error) {
      if (!isPathRequiresApprovalError(error) || !context.approveWorkspacePath) throw error;

      const decision = await context.approveWorkspacePath({
        tool: name,
        input: normalizedInput,
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

function parseToolInput(tool: RuntimeTool<z.ZodType, RuntimeToolOutput>, input: unknown) {
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
