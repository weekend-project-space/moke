import type { AgentEvent, Message } from './conversation'
import {
  awaitRunApproval,
  awaitRunUser,
  finishRunState,
  resumeRun,
  type SessionRunState,
} from './runState'
import { applyToolCallEvent } from '../presentation/toolCallProjector'

export type RunEventEffects = {
  answerDelta?: string
  message?: Message
  finish: boolean
}

export type RunEventReduction = {
  accepted: boolean
  state: SessionRunState
  effects: RunEventEffects
}

function eventKey(event: AgentEvent) {
  return event.eventId || `${event.sequence}:${event.type}:${event.timestamp}`
}

function shouldStoreEvent(event: AgentEvent) {
  return event.type === 'message.content'
    || event.type === 'reasoning_message.content'
    || event.type === 'tool_call.started'
    || event.type === 'tool_call.completed'
    || event.type === 'tool_result.completed'
    || event.type === 'tool_result.failed'
    || event.type === 'run.failed'
    || event.type === 'run.timed_out'
}

export function reduceRunEvent(state: SessionRunState, event: AgentEvent): RunEventReduction {
  const key = eventKey(event)
  if (state.seenEventKeys.has(key)) {
    return { accepted: false, state, effects: { finish: false } }
  }

  const storesEvent = shouldStoreEvent(event)
  const nextState: SessionRunState = {
    ...state,
    events: state.events,
    seenEventKeys: new Set(state.seenEventKeys).add(key),
    toolCalls: state.toolCalls,
  }
  if (storesEvent) appendDisplayEvent(nextState.events, event)
  if (event.type.startsWith('tool_') || event.type.startsWith('tool_result.')) {
    applyToolCallEvent(nextState.toolCalls, event)
  }
  if (event.type === 'interaction.resolved' && event.response.decision === 'answered') {
    const callId = state.lifecycle.status === 'awaiting-user' && state.lifecycle.ask.ask_id === event.interactionId
      ? state.lifecycle.ask.call_id
      : event.interactionId
    const option = state.lifecycle.status === 'awaiting-user'
      ? state.lifecycle.ask.options.find(item => item.id === event.response.optionId)
      : undefined
    nextState.answeredInteractions.set(callId, option?.label || event.response.answer || event.response.optionId || '')
  }
  const effects: RunEventEffects = { finish: false }

  if (event.type === 'message.content') {
    effects.answerDelta = event.delta
  } else if (event.type === 'interaction.required' && event.interaction.type === 'approval') {
    awaitRunApproval(nextState, { approval_id: event.interaction.id, call_id: event.interaction.toolCallId, kind: event.interaction.approvalKind, reason: event.interaction.reason, action: event.interaction.action, path: event.interaction.path, suggested_root: event.interaction.suggestedRoot, created_at: new Date(event.timestamp).toISOString() })
  } else if (event.type === 'interaction.required' && event.interaction.type === 'question') {
    awaitRunUser(nextState, { ask_id: event.interaction.id, call_id: event.interaction.toolCallId || '', question: event.interaction.question, options: event.interaction.options || [], created_at: new Date(event.timestamp).toISOString() })
  } else if (
    event.type === 'interaction.resolved'
    && nextState.lifecycle.status === 'awaiting-user'
    && nextState.lifecycle.ask.ask_id === event.interactionId
  ) {
    resumeRun(nextState)
  } else if (
    event.type === 'interaction.resolved'
    && nextState.lifecycle.status === 'awaiting-approval'
    && nextState.lifecycle.approval.approval_id === event.interactionId
  ) {
    resumeRun(nextState)
  } else if (event.type === 'message.completed' && event.message.role === 'assistant') {
    effects.message = {
      id: event.message.id,
      role: 'assistant',
      content: event.message.content || '',
      created_at: new Date(event.timestamp).toISOString(),
      ...(event.reasoning ? { reasoning: event.reasoning } : {}),
      ...(event.message.toolCalls?.length ? {
        tool_calls: event.message.toolCalls.map(call => ({
          id: call.id,
          name: call.function.name,
          args: parseToolArguments(call.function.arguments),
        })),
      } : {}),
    }
  } else if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.timed_out' || event.type === 'run.cancelled') {
    finishRunState(nextState)
    effects.finish = true
  }

  return { accepted: true, state: nextState, effects }
}

function appendDisplayEvent(events: AgentEvent[], event: AgentEvent) {
  const previous = events.at(-1)
  if (
    event.type === 'message.content'
    && previous?.type === 'message.content'
    && previous.messageId === event.messageId
  ) {
    events[events.length - 1] = { ...previous, delta: previous.delta + event.delta }
    return
  }

  if (
    event.type === 'reasoning_message.content'
    && previous?.type === 'reasoning_message.content'
    && previous.messageId === event.messageId
    && previous.stepId === event.stepId
  ) {
    events[events.length - 1] = { ...previous, delta: previous.delta + event.delta }
    return
  }

  events.push(event)
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
