import type { AgentToolCall, AgentToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolProvider, ValidatedToolCall } from '@moke/agent-protocol';

export type RegisteredTool = AgentToolDefinition & {
  prepare?: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
  execute: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
};

export class ToolProviderError extends Error {
  constructor(readonly code: 'unknown_tool' | 'invalid_arguments', message: string) { super(message); this.name = 'ToolProviderError'; }
}

export class RegistryToolProvider implements ToolProvider {
  private readonly tools = new Map<string, RegisteredTool>();
  constructor(tools: RegisteredTool[] = []) { for (const tool of tools) this.register(tool); }
  register(tool: RegisteredTool) { if (this.tools.has(tool.name)) throw new ToolProviderError('unknown_tool', `Tool already registered: ${tool.name}`); this.tools.set(tool.name, tool); return this; }
  unregister(name: string) { this.tools.delete(name); }
  listTools(filter?: { names?: string[] }) {
    const names = filter?.names;
    return [...this.tools.values()].filter(tool => !names || names.includes(tool.name)).map(({ prepare: _prepare, execute: _execute, ...definition }) => definition);
  }
  validate(call: AgentToolCall): ValidatedToolCall {
    const tool = this.tools.get(call.function.name);
    if (!tool) throw new ToolProviderError('unknown_tool', `Unknown tool: ${call.function.name}`);
    let parsed: unknown;
    try { parsed = JSON.parse(call.function.arguments || '{}'); } catch (error) { throw new ToolProviderError('invalid_arguments', `Invalid JSON arguments for ${call.function.name}`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ToolProviderError('invalid_arguments', `Tool arguments must be an object for ${call.function.name}`);
    return { ...call, parsedArguments: parsed as Record<string, unknown> };
  }
  async execute(call: ValidatedToolCall, context: ToolExecutionContext) {
    const tool = this.tools.get(call.function.name);
    if (!tool) throw new ToolProviderError('unknown_tool', `Unknown tool: ${call.function.name}`);
    const prepared = tool.prepare ? await tool.prepare(call.parsedArguments, context) : call.parsedArguments;
    return tool.execute(prepared, context);
  }
}
