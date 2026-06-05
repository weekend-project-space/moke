import type { EventBus } from './event-bus.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';

type ExecuteToolInput = {
  callId: string;
  toolName: string;
  input: unknown;
  eventBus: EventBus;
  toolRegistry: ToolRegistry;
  context: ToolContext;
};

export class ToolExecutor {
  async execute({ callId, toolName, input, eventBus, toolRegistry, context }: ExecuteToolInput) {
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      const output = { error: `Tool not found: ${toolName}` };
      eventBus.emit('tool.result', {
        call_id: callId,
        status: 'error',
        duration_ms: 0,
        output,
      });
      return output;
    }

    eventBus.emit('tool.call', {
      call_id: callId,
      tool: toolName,
      input: input as Record<string, unknown>,
      risk: tool.risk,
    });

    const startedAt = Date.now();
    try {
      const output = await toolRegistry.execute(toolName, input, context);
      eventBus.emit('tool.result', {
        call_id: callId,
        status: 'ok',
        duration_ms: Date.now() - startedAt,
        output,
      });
      return output;
    } catch (error) {
      const output = {
        error: error instanceof Error ? error.message : String(error),
      };
      eventBus.emit('tool.result', {
        call_id: callId,
        status: 'error',
        duration_ms: Date.now() - startedAt,
        output,
      });
      return output;
    }
  }
}
