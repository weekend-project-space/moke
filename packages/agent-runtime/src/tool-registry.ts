import type { z } from 'zod';

import type { RiskLevel } from '../../protocol/src/index.js';

export type ToolContext = {
  workspace: string;
};

export type RuntimeTool<TInput extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  risk: RiskLevel;
  schema: TInput;
  handler: (input: z.infer<TInput>, context: ToolContext) => Promise<Record<string, unknown>>;
};

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
      throw new Error(`Tool not found: ${name}`);
    }

    const parsedInput = tool.schema.parse(input);
    return tool.handler(parsedInput, context);
  }
}
