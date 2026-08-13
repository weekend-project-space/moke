import type { ActivityMessage, AgentEvent, AgentMessage, AgentRunSnapshot, JsonPatchOperation } from './types.js';

export function createAgentRunSnapshot(threadId: string, runId: string): AgentRunSnapshot {
  return { threadId, runId, status: 'queued', messages: [], state: {}, activities: [], lastSequence: 0, usage: { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 } };
}

export function reduceAgentEvent(snapshot: AgentRunSnapshot, event: AgentEvent): AgentRunSnapshot {
  if (event.threadId !== snapshot.threadId || event.runId !== snapshot.runId) throw new Error('Event identity does not match snapshot');
  if (event.sequence <= snapshot.lastSequence) throw new Error('Event sequence must increase');
  const next = { ...snapshot, messages: structuredClone(snapshot.messages), activities: structuredClone(snapshot.activities), state: structuredClone(snapshot.state), lastSequence: event.sequence };
  switch (event.type) {
    case 'run.started': next.status = 'running'; break;
    case 'run.completed': next.status = 'completed'; next.messages = [...event.result.messages]; next.state = structuredClone(event.result.state); next.usage = { ...event.result.usage }; break;
    case 'run.failed': next.status = 'failed'; break;
    case 'run.cancelled': next.status = 'cancelled'; break;
    case 'step.started': next.usage = { ...next.usage, steps: next.usage.steps + 1 }; break;
    case 'message.started': next.messages.push({ id: event.messageId, role: 'assistant', content: '' }); break;
    case 'message.content': updateText(next.messages, event.messageId, event.delta); break;
    case 'message.completed': upsertMessage(next.messages, event.message); break;
    case 'reasoning_message.started': next.messages.push({ id: event.messageId, role: 'reasoning', content: '' }); break;
    case 'reasoning_message.content': updateText(next.messages, event.messageId, event.delta); break;
    case 'tool_call.started': {
      const parent = event.parentMessageId ? next.messages.find(message => message.id === event.parentMessageId && message.role === 'assistant') : undefined;
      if (parent?.role === 'assistant') parent.toolCalls = [...(parent.toolCalls ?? []), { id: event.toolCallId, type: 'function', function: { name: event.toolCallName, arguments: '' } }];
      break;
    }
    case 'tool_call.args': {
      const call = next.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : []).find(item => item.id === event.toolCallId);
      if (call) call.function.arguments += event.delta;
      break;
    }
    case 'tool_result.completed':
    case 'tool_result.failed':
      next.messages.push({ id: event.messageId, role: 'tool', toolCallId: event.toolCallId, content: event.content, error: event.error });
      next.usage = { ...next.usage, toolCalls: next.usage.toolCalls + 1 };
      break;
    case 'state.snapshot': next.state = structuredClone(event.snapshot); break;
    case 'state.delta': next.state = applyPatch(next.state, event.delta); break;
    case 'messages.snapshot': next.messages = structuredClone(event.messages); break;
    case 'activity.snapshot': upsertActivity(next.activities, event); break;
    case 'activity.delta': {
      const activity = next.activities.find(item => item.id === event.messageId);
      if (activity) activity.content = applyPatch(activity.content, event.patch);
      break;
    }
    case 'interaction.required': next.pendingInteraction = event.interaction; next.status = event.interaction.type === 'approval' ? 'awaiting_approval' : 'awaiting_user'; break;
    case 'interaction.resolved': next.pendingInteraction = undefined; next.status = 'running'; break;
  }
  return next;
}

function updateText(messages: AgentMessage[], id: string, delta: string) {
  const message = messages.find(item => item.id === id);
  if (message?.role === 'assistant' || message?.role === 'reasoning') message.content = (message.content ?? '') + delta;
}

function upsertMessage(messages: AgentMessage[], message: AgentMessage) {
  const index = messages.findIndex(item => item.id === message.id);
  if (index >= 0) messages[index] = structuredClone(message);
  else messages.push(structuredClone(message));
}

function upsertActivity(activities: ActivityMessage[], event: Extract<AgentEvent, { type: 'activity.snapshot' }>) {
  const index = activities.findIndex(item => item.id === event.messageId);
  if (index >= 0) {
    if (event.replace !== false) activities[index] = { id: event.messageId, role: 'activity', activityType: event.activityType, content: structuredClone(event.content) };
  } else activities.push({ id: event.messageId, role: 'activity', activityType: event.activityType, content: structuredClone(event.content) });
}

function applyPatch<T extends Record<string, unknown>>(input: T, patch: JsonPatchOperation[]): T {
  const value = structuredClone(input);
  for (const operation of patch) {
    const segments = operation.path.split('/').slice(1).map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    let target: Record<string, unknown> = value;
    for (const segment of segments.slice(0, -1)) target = target[segment] as Record<string, unknown>;
    const key = segments.at(-1);
    if (!key) throw new Error('JSON Patch root operations are not supported');
    if (operation.op === 'remove') delete target[key];
    else if (operation.op === 'add' || operation.op === 'replace') target[key] = structuredClone(operation.value);
    else if (operation.op === 'test' && !Object.is(target[key], operation.value)) throw new Error(`JSON Patch test failed at ${operation.path}`);
  }
  return value;
}
