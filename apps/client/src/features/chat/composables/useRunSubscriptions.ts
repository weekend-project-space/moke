import { reactive, type Ref, type ShallowRef } from 'vue'
import type { RunHandle, RunLifecycleEvent, RunStatus } from '@moke/agent-sdk'

import type { AgentApi } from '../api/agentApi'
import type { AgentEvent } from '../model/conversation'
import type { SessionRunState } from '../model/runState'
import { connectRun, createSessionRunState, finishRunState, isRunActive, markRunConnected, markRunReconnecting } from '../model/runState'
import type { StreamingTextBuffer } from '../services/streamingTextBuffer'

type RunSubscriptionOptions = {
  api: AgentApi
  sessionId: Ref<string>
  sessionRunStates: Record<string, SessionRunState | undefined>
  currentRun: ShallowRef<RunHandle | undefined>
  streamingTextBuffer: StreamingTextBuffer
  onEvent: (sessionId: string, event: AgentEvent) => void
  onExternalRun: (sessionId: string) => void
  onActiveRun: (event: RunLifecycleEvent) => void
  onTerminalRun: (event: RunLifecycleEvent) => void
  reconnectingMessage: string
  disconnectedMessage: string
}

export function useRunSubscriptions(options: RunSubscriptionOptions) {
  const activeRuns = reactive<Record<string, { runId: string; status: RunStatus }>>({})
  const pendingLocalSessions = new Set<string>()
  const localRunIds = new Set<string>()
  let stopRunLifecycle: (() => void) | undefined
  let stopSessionRun: (() => void) | undefined
  let watchedSessionId = ''

  function ensureRunState(targetSessionId: string) {
    if (!options.sessionRunStates[targetSessionId]) options.sessionRunStates[targetSessionId] = createSessionRunState()
    return options.sessionRunStates[targetSessionId]!
  }

  function start() {
    if (stopRunLifecycle) return
    stopRunLifecycle = options.api.onRunLifecycle(handleRunLifecycle, {
      onReconnect: clearActiveRuns,
      onError: clearActiveRuns,
    })
  }

  function clearActiveRuns() {
    for (const targetSessionId of Object.keys(activeRuns)) delete activeRuns[targetSessionId]
  }

  function handleRunLifecycle(event: RunLifecycleEvent) {
    const previous = activeRuns[event.sessionId]
    if (isTerminalRunStatus(event.type)) {
      localRunIds.delete(event.runId)
      if (previous?.runId === event.runId) delete activeRuns[event.sessionId]
      options.onTerminalRun(event)
      return
    }

    activeRuns[event.sessionId] = { runId: event.runId, status: event.type }
    options.onActiveRun(event)
    if (previous?.runId === event.runId) return
    const isLocalRun = pendingLocalSessions.has(event.sessionId) || localRunIds.has(event.runId)
    if (event.sessionId === options.sessionId.value && !isLocalRun) options.onExternalRun(event.sessionId)
  }

  function watch(targetSessionId: string) {
    if (targetSessionId && watchedSessionId === targetSessionId && stopSessionRun) return
    stopSessionRun?.()
    stopSessionRun = undefined
    watchedSessionId = targetSessionId
    options.currentRun.value = undefined
    if (!targetSessionId) return

    stopSessionRun = options.api.onSessionRunEvent(targetSessionId, (event, run) => {
      if (options.sessionId.value !== targetSessionId) return
      const state = ensureRunState(targetSessionId)
      if (state.runId !== run.id) {
        options.streamingTextBuffer.clear(targetSessionId)
        state.events = []
        state.toolCalls.clear()
        state.answeredInteractions.clear()
        state.seenEventKeys.clear()
        connectRun(state, run.id)
      }
      options.currentRun.value = run
      markRunConnected(state)
      options.onEvent(targetSessionId, event)
    }, {
      onReconnect: (run) => {
        if (options.sessionId.value !== targetSessionId || options.currentRun.value?.id !== run.id) return
        const state = options.sessionRunStates[targetSessionId]
        if (state && isRunActive(state)) markRunReconnecting(state, options.reconnectingMessage)
      },
      onError: () => {
        if (options.sessionId.value !== targetSessionId) return
        const state = options.sessionRunStates[targetSessionId]
        if (state && isRunActive(state)) finishRunState(state, options.disconnectedMessage)
      },
    })
  }

  function dispose() {
    stopSessionRun?.()
    stopSessionRun = undefined
    watchedSessionId = ''
    options.currentRun.value = undefined
    stopRunLifecycle?.()
    stopRunLifecycle = undefined
    clearActiveRuns()
    pendingLocalSessions.clear()
    localRunIds.clear()
  }

  return { activeRuns, pendingLocalSessions, localRunIds, start, watch, dispose }
}

function isTerminalRunStatus(status: RunLifecycleEvent['type']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout'
}
