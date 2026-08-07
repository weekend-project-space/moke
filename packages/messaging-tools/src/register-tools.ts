import type { ToolRegistry } from '@moke/agent-runtime';
import type { MessagingToolBackend } from './messaging-tool-backend.js';
import { createSendMessageTool } from './send-message.js';

export function registerMessagingTools(toolRegistry: ToolRegistry, backend: MessagingToolBackend) {
  return toolRegistry.register(createSendMessageTool(backend));
}
