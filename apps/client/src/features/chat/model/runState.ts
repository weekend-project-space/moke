import type { AgentEvent, PendingApproval, PendingAsk } from '../../../types/conversation'

export type RunLifecycle =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'running' }
  | { status: 'awaiting-user'; ask: PendingAsk }
  | { status: 'awaiting-approval'; approval: PendingApproval }

export type SessionRunState = {
  runId: string
  events: AgentEvent[]
  streamingText: string
  lifecycle: RunLifecycle
  connection: 'disconnected' | 'connected' | 'reconnecting'
  error: string
  seenEventKeys: Set<string>
}

export function createSessionRunState(runId = ''): SessionRunState {
  return {
    runId,
    events: [],
    streamingText: '',
    lifecycle: { status: 'idle' },
    connection: 'disconnected',
    error: '',
    seenEventKeys: new Set<string>(),
  }
}

export function isRunActive(state: SessionRunState) {
  return state.lifecycle.status !== 'idle'
}

export function pendingAskFrom(state: SessionRunState) {
  return state.lifecycle.status === 'awaiting-user' ? state.lifecycle.ask : null
}

export function pendingApprovalFrom(state: SessionRunState) {
  return state.lifecycle.status === 'awaiting-approval' ? state.lifecycle.approval : null
}

export function startRun(state: SessionRunState) {
  state.lifecycle = { status: 'starting' }
  state.connection = 'disconnected'
  state.error = ''
}

export function connectRun(
  state: SessionRunState,
  runId: string,
  pendingAsk?: PendingAsk,
  pendingApproval?: PendingApproval,
) {
  state.runId = runId
  state.connection = 'connected'
  state.error = ''
  if (pendingAsk) {
    state.lifecycle = { status: 'awaiting-user', ask: pendingAsk }
  } else if (pendingApproval) {
    state.lifecycle = { status: 'awaiting-approval', approval: pendingApproval }
  } else {
    state.lifecycle = { status: 'running' }
  }
}

export function finishRunState(state: SessionRunState, error = '') {
  state.lifecycle = { status: 'idle' }
  state.connection = 'disconnected'
  state.error = error
}
