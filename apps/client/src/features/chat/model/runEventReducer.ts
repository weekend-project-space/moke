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

export function reduceRunEvent(state: SessionRunState, event: AgentEvent): RunEventReduction {
  const key = eventKey(event)
  if (state.seenEventKeys.has(key)) {
    return { accepted: false, state, effects: { finish: false } }
  }

  const isAnswerDelta = event.type === 'agent.message.delta' && event.payload.channel !== 'reasoning'
  const nextState: SessionRunState = {
    ...state,
    events: isAnswerDelta ? state.events : [...state.events, event],
    seenEventKeys: new Set(state.seenEventKeys).add(key),
  }
  const effects: RunEventEffects = { finish: false }

  if (event.type === 'agent.message.delta' && isAnswerDelta) {
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
