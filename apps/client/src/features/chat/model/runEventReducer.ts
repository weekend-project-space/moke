import type { AgentEvent, Message, PendingAsk } from './conversation'
import {
  awaitRunApproval,
  awaitRunUser,
  finishRunState,
  type SessionRunState,
} from './runState'

export type RunEventEffects = {
  answerDelta?: string
  message?: Message
  ask?: PendingAsk
  finish: boolean
}

export type RunEventReduction = {
  accepted: boolean
  state: SessionRunState
  effects: RunEventEffects
}

function eventKey(event: AgentEvent) {
  return event.id || `${event.seq || ''}:${event.type}:${event.ts || ''}`
}

function shouldStoreEvent(event: AgentEvent) {
  if (event.type === 'agent.message.delta') return event.payload.channel === 'reasoning'
  return event.type === 'tool.call' || event.type === 'tool.result' || event.type === 'agent.error'
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

  if (event.type === 'agent.message.delta' && event.payload.channel !== 'reasoning') {
    effects.answerDelta = event.payload.content
  } else if (event.type === 'approval.required') {
    awaitRunApproval(nextState, event.payload)
  } else if (event.type === 'ask_user.required') {
    awaitRunUser(nextState, event.payload)
    effects.ask = event.payload
  } else if (event.type === 'agent.message.done') {
    effects.message = event.payload.message
  } else if (event.type === 'agent.done' || event.type === 'agent.error') {
    finishRunState(nextState)
    effects.finish = true
  }

  return { accepted: true, state: nextState, effects }
}
