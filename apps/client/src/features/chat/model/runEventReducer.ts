import type { AgentEvent, Message } from './conversation'
import {
  awaitRunApproval,
  awaitRunUser,
  finishRunState,
  resumeRun,
  type SessionRunState,
} from './runState'

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
  return event.type === 'reasoning_message.content'
    || event.type === 'tool_call.started'
    || event.type === 'tool_call.args'
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
    events: storesEvent ? [...state.events, event] : state.events,
    seenEventKeys: new Set(state.seenEventKeys).add(key),
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
    effects.message = { id: event.message.id, role: 'assistant', content: event.message.content || '', created_at: new Date(event.timestamp).toISOString() }
  } else if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.timed_out' || event.type === 'run.cancelled') {
    finishRunState(nextState)
    effects.finish = true
  }

  return { accepted: true, state: nextState, effects }
}
