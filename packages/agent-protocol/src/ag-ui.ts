import type { AgentEvent, AgentMessage, AgentRunInput, AgentToolDefinition, InputContent, JsonPatchOperation } from './types.js';

export type AgUiRunAgentInput = {
  threadId: string;
  runId: string;
  parentRunId?: string;
  state: unknown;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  context: Array<{ description: string; value: string }>;
  forwardedProps: unknown;
};

export type AgUiEvent = { type: string; timestamp?: number; rawEvent?: unknown } & Record<string, unknown>;

export function fromAgUiRunInput(input: AgUiRunAgentInput): AgentRunInput {
  if (input.tools.length) throw new Error('Client-provided tools are not supported');
  const messages = [...input.messages];
  const last = messages.at(-1);
  const content: string | InputContent[] = last?.role === 'user' ? last.content : '';
  if (last?.role === 'user') messages.pop();
  return { threadId: input.threadId, runId: input.runId, parentRunId: input.parentRunId, input: content, messages, state: object(input.state), context: input.context };
}

export function toAgUiEvent(event: AgentEvent): AgUiEvent {
  const base = { timestamp: Date.parse(event.timestamp), rawEvent: event.rawEvent };
  switch (event.type) {
    case 'run.started': return { ...base, type: 'RUN_STARTED', threadId: event.threadId, runId: event.runId, parentRunId: event.parentRunId };
    case 'run.completed': return { ...base, type: 'RUN_FINISHED', threadId: event.threadId, runId: event.runId, result: event.result };
    case 'run.failed': return { ...base, type: 'RUN_ERROR', message: event.error.message, code: event.error.code };
    case 'run.cancelled': return { ...base, type: 'RUN_ERROR', message: event.reason ?? 'Run cancelled', code: 'cancelled' };
    case 'step.started': return { ...base, type: 'STEP_STARTED', stepName: event.stepName };
    case 'step.completed': return { ...base, type: 'STEP_FINISHED', stepName: event.stepName };
    case 'message.started': return { ...base, type: 'TEXT_MESSAGE_START', messageId: event.messageId, role: event.role };
    case 'message.content': return { ...base, type: 'TEXT_MESSAGE_CONTENT', messageId: event.messageId, delta: event.delta };
    case 'message.completed': return { ...base, type: 'TEXT_MESSAGE_END', messageId: event.messageId };
    case 'tool_call.started': return { ...base, type: 'TOOL_CALL_START', toolCallId: event.toolCallId, toolCallName: event.toolCallName, parentMessageId: event.parentMessageId };
    case 'tool_call.args': return { ...base, type: 'TOOL_CALL_ARGS', toolCallId: event.toolCallId, delta: event.delta };
    case 'tool_call.completed': return { ...base, type: 'TOOL_CALL_END', toolCallId: event.toolCallId };
    case 'tool_result.completed': case 'tool_result.failed': return { ...base, type: 'TOOL_CALL_RESULT', messageId: event.messageId, toolCallId: event.toolCallId, content: event.content, role: 'tool' };
    case 'state.snapshot': return { ...base, type: 'STATE_SNAPSHOT', snapshot: event.snapshot };
    case 'state.delta': return { ...base, type: 'STATE_DELTA', delta: event.delta };
    case 'messages.snapshot': return { ...base, type: 'MESSAGES_SNAPSHOT', messages: event.messages };
    case 'activity.snapshot': return { ...base, type: 'ACTIVITY_SNAPSHOT', messageId: event.messageId, activityType: event.activityType, content: event.content, replace: event.replace };
    case 'activity.delta': return { ...base, type: 'ACTIVITY_DELTA', messageId: event.messageId, activityType: event.activityType, patch: event.patch };
    case 'reasoning.started': return { ...base, type: 'REASONING_START', messageId: event.messageId };
    case 'reasoning_message.started': return { ...base, type: 'REASONING_MESSAGE_START', messageId: event.messageId, role: event.role };
    case 'reasoning_message.content': return { ...base, type: 'REASONING_MESSAGE_CONTENT', messageId: event.messageId, delta: event.delta };
    case 'reasoning_message.completed': return { ...base, type: 'REASONING_MESSAGE_END', messageId: event.messageId };
    case 'reasoning.completed': return { ...base, type: 'REASONING_END', messageId: event.messageId };
    case 'reasoning.encrypted_value': return { ...base, type: 'REASONING_ENCRYPTED_VALUE', subtype: event.subtype, entityId: event.entityId, encryptedValue: event.encryptedValue };
    case 'raw': return { ...base, type: 'RAW', event: event.event, source: event.source };
    case 'custom': return { ...base, type: 'CUSTOM', name: event.name, value: event.value };
    case 'interaction.required': return { ...base, type: 'CUSTOM', name: 'agent.interaction.required', value: event.interaction };
    case 'interaction.resolved': return { ...base, type: 'CUSTOM', name: 'agent.interaction.resolved', value: { interactionId: event.interactionId, response: event.response } };
  }
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
