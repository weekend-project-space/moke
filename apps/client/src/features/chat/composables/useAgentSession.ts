import { computed, nextTick, reactive, ref, shallowRef } from 'vue'
import type { RunHandle, RunLifecycleEvent, RunStatus } from '@moke/agent-sdk'
import { createLatestRequestGuard } from '../services/latestRequest'
import type { AgentEvent, AskOption, ImageAttachment, Message, ReasoningEffort, SessionSummary } from '../model/conversation'
import { uiText } from '../../../text/uiText'
import { AgentApiError, createAgentApi, type AgentApi } from '../api/agentApi'
import { appendOptimisticUserMessage } from '../model/optimisticMessages'
import { reduceRunEvent } from '../model/runEventReducer'
import {
  connectRun,
  createSessionRunState,
  finishRunState,
  isRunActive,
  markRunConnected,
  markRunReconnecting,
  pendingApprovalFrom,
  pendingAskFrom,
  resumeRun,
  setRunError,
  startRun,
  type SessionRunState,
} from '../model/runState'
import { createStreamingTextBuffer } from '../services/streamingTextBuffer'

type UseAgentSessionOptions = {
  apiBase: string
  api?: AgentApi
  isFinalAssistantMessage: (message: Message | undefined) => boolean
  onMessagesLoaded?: () => void | Promise<void>
  onRunFinished?: (sessionId: string) => void | Promise<void>
}

export type SendMessageInput = {
  content: string
  attachments?: ImageAttachment[]
  options?: {
    reasoningEffort?: ReasoningEffort
  }
}

export function useAgentSession(options: UseAgentSessionOptions) {
  const sessionId = ref('')
  const messages = ref<Message[]>([])
  const sessions = ref<SessionSummary[]>([])
  const serverStatus = ref<'checking' | 'online' | 'offline'>('checking')
  const submittingAskId = ref('')
  const submittingApprovalId = ref('')
  const sessionRunStates = reactive<Record<string, SessionRunState>>({})
  const activeRuns = reactive<Record<string, { runId: string; status: RunStatus }>>({})
  const currentRun = shallowRef<RunHandle>()
  const sessionLoadGuard = createLatestRequestGuard()
  const api = options.api || createAgentApi(options.apiBase)
  const pendingLocalSessions = new Set<string>()
  const localRunIds = new Set<string>()
  let stopRunLifecycle: (() => void) | undefined
  let stopSessionRun: (() => void) | undefined
  let watchedSessionId = ''
  let sessionsRefreshTimer: number | undefined
  const streamingTextBuffer = createStreamingTextBuffer({
    onFlush: (targetSessionId, text) => {
      ensureRunState(targetSessionId).streamingText = text
    },
  })
  const emptyRunState = createSessionRunState()
  const currentRunState = computed(() => (sessionId.value ? sessionRunStates[sessionId.value] : undefined) || emptyRunState)
  const runId = computed(() => currentRunState.value.runId)
  const events = computed(() => currentRunState.value.events)
  const streamingText = computed(() => currentRunState.value.streamingText)
  const pendingApproval = computed(() => pendingApprovalFrom(currentRunState.value))
  const pendingAsk = computed(() => pendingAskFrom(currentRunState.value))
  const isSubmittingAsk = computed(() => Boolean(pendingAsk.value?.ask_id && submittingAskId.value === pendingAsk.value.ask_id))
  const isSubmittingApproval = computed(() => Boolean(
    pendingApproval.value?.approval_id && submittingApprovalId.value === pendingApproval.value.approval_id,
  ))
  const isRunning = computed(() => isRunActive(currentRunState.value))
  const runError = computed(() => currentRunState.value.error)
  const runningSessionIds = computed(() =>
    Object.keys(activeRuns),
  )

  const sortedSessions = computed(() =>
    [...sessions.value].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return Date.parse(right.updated_at) - Date.parse(left.updated_at)
    }),
  )

  function ensureRunState(targetSessionId: string) {
    if (!sessionRunStates[targetSessionId]) sessionRunStates[targetSessionId] = createSessionRunState()
    return sessionRunStates[targetSessionId]
  }

  function resetRunState(targetSessionId: string) {
    streamingTextBuffer.clear(targetSessionId)
    delete sessionRunStates[targetSessionId]
  }

  function startRunLifecycle() {
    if (stopRunLifecycle) return
    stopRunLifecycle = api.onRunLifecycle(handleRunLifecycle, {
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
      scheduleSessionsRefresh()
      return
    }

    activeRuns[event.sessionId] = { runId: event.runId, status: event.type }
    if (previous?.runId === event.runId) return

    scheduleSessionsRefresh()
    const isLocalRun = pendingLocalSessions.has(event.sessionId) || localRunIds.has(event.runId)
    if (event.sessionId === sessionId.value && !isLocalRun) {
      void refreshSessionMessagesIfActive(event.sessionId)
    }
  }

  function watchSessionRun(targetSessionId: string) {
    if (targetSessionId && watchedSessionId === targetSessionId && stopSessionRun) return
    stopSessionRun?.()
    stopSessionRun = undefined
    watchedSessionId = targetSessionId
    currentRun.value = undefined
    if (!targetSessionId) return

    stopSessionRun = api.onSessionRunEvent(targetSessionId, (event, run) => {
      if (sessionId.value !== targetSessionId) return
      const state = ensureRunState(targetSessionId)
      if (state.runId !== run.id) {
        streamingTextBuffer.clear(targetSessionId)
        state.events = []
        state.seenEventKeys.clear()
        connectRun(state, run.id)
      }
      currentRun.value = run
      markRunConnected(state)
      handleRunEvent(targetSessionId, event)
    }, {
      onReconnect: (run) => {
        if (sessionId.value !== targetSessionId || currentRun.value?.id !== run.id) return
        const state = sessionRunStates[targetSessionId]
        if (state && isRunActive(state)) markRunReconnecting(state, uiText.app.reconnecting)
      },
      onError: () => {
        if (sessionId.value !== targetSessionId) return
        const state = sessionRunStates[targetSessionId]
        if (state && isRunActive(state)) finishRunState(state, uiText.app.disconnectedFromMoke)
      },
    })
  }

  function scheduleSessionsRefresh() {
    if (sessionsRefreshTimer !== undefined) return
    sessionsRefreshTimer = window.setTimeout(() => {
      sessionsRefreshTimer = undefined
      void loadSessions()
    }, 50)
  }

  async function checkServer() {
    serverStatus.value = 'checking'

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if (await api.checkHealth()) {
          serverStatus.value = 'online'
          startRunLifecycle()
          return true
        }
      } catch {
        // Retry while the desktop shell is starting the local server.
      }

      await new Promise((resolve) => window.setTimeout(resolve, 300))
    }

    serverStatus.value = 'offline'
    return false
  }

  async function createSession() {
    if (serverStatus.value !== 'online' && !(await checkServer())) return false

    try {
      const nextSessionId = await api.createSession(uiText.app.newChat)

      sessionId.value = nextSessionId
      messages.value = []
      resetRunState(nextSessionId)
      watchSessionRun(nextSessionId)
      await loadSessions()
      return true
    } catch {
      return false
    }
  }

  async function loadSessions() {
    if (serverStatus.value !== 'online') return

    try {
      sessions.value = await api.listSessions()
    } catch {
      // Keep the last successful session list during transient failures.
    }
  }

  async function updateSession(id: string, payload: Record<string, unknown>, optionsOverride: { allowWhileRunning?: boolean } = {}) {
    if (!id || (!optionsOverride.allowWhileRunning && sessionRunStates[id] && isRunActive(sessionRunStates[id]))) return false
    if (serverStatus.value !== 'online' && !(await checkServer())) return false

    try {
      await api.updateSession(id, payload)
    } catch {
      return false
    }

    await loadSessions()
    return true
  }

  async function renameSession(id: string, title: string) {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return false
    return updateSession(id, { title: trimmedTitle })
  }

  async function pinSession(id: string, pinned: boolean) {
    if (!id) return false
    return updateSession(id, { pinned }, { allowWhileRunning: true })
  }

  async function archiveSession(id: string) {
    if (!(await updateSession(id, { archived: true }))) return false
    resetRunState(id)
    if (id !== sessionId.value) return true

    const nextSession = sortedSessions.value.find((session) => session.id !== id)
    if (nextSession) return loadSessionMessages(nextSession.id)

    sessionId.value = ''
    messages.value = []
    return createSession()
  }

  async function loadSessionMessages(id: string, optionsOverride: { notify?: boolean } = {}) {
    const request = sessionLoadGuard.start()

    try {
      const loadedMessages = await api.loadSessionMessages(id, request.signal)
      if (!request.isCurrent()) return false

      sessionId.value = id
      messages.value = loadedMessages
      watchSessionRun(id)

      if (optionsOverride.notify !== false) {
        await nextTick()
        await options.onMessagesLoaded?.()
      }
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false
      return false
    } finally {
      request.release()
    }
  }

  async function refreshSessionMessagesIfActive(targetSessionId: string) {
    if (sessionId.value !== targetSessionId) return
    await loadSessionMessages(targetSessionId)
  }

  async function selectSession(id: string) {
    if (id === sessionId.value) return false
    return loadSessionMessages(id)
  }

  async function forkSession(messageId: string) {
    if (!sessionId.value || !messageId || isRunning.value) return false
    if (serverStatus.value !== 'online' && !(await checkServer())) return false

    let forked
    try {
      forked = await api.forkSession(sessionId.value, messageId)
    } catch {
      return false
    }

    await loadSessions()
    sessionId.value = forked.sessionId
    messages.value = forked.messages
    resetRunState(forked.sessionId)
    watchSessionRun(forked.sessionId)
    await nextTick()
    await options.onMessagesLoaded?.()
    return true
  }

  async function sendMessage(input: string | SendMessageInput) {
    const draft = typeof input === 'string' ? { content: input } : input
    const trimmedContent = draft.content.trim()
    const attachments = draft.attachments || []
    if ((!trimmedContent && !attachments.length) || isRunning.value) return false

    if (serverStatus.value !== 'online' && !(await checkServer())) return false
    if (!sessionId.value) await createSession()
    if (!sessionId.value) return false

    const targetSessionId = sessionId.value
    const state = ensureRunState(targetSessionId)
    state.events = []
    state.seenEventKeys.clear()
    streamingTextBuffer.clear(targetSessionId)
    startRun(state)
    const optimisticMessage = appendOptimisticUserMessage(messages.value, {
      content: trimmedContent,
      attachments,
    })
    pendingLocalSessions.add(targetSessionId)

    try {
      const run = await api.sendMessage(targetSessionId, {
        content: trimmedContent,
        attachments,
        reasoningEffort: draft.options?.reasoningEffort,
      })

      localRunIds.add(run.id)
      if (currentRun.value?.id !== run.id) currentRun.value = run
      if (state.runId !== run.id || state.lifecycle.status === 'starting') connectRun(state, run.id)
      scheduleSessionsRefresh()
      return true
    } catch {
      finishRunState(state, uiText.app.sendFailed)
      optimisticMessage.rollback()
      void checkServer()
      return false
    } finally {
      pendingLocalSessions.delete(targetSessionId)
    }
  }

  function disposeAgentSession() {
    stopSessionRun?.()
    stopSessionRun = undefined
    watchedSessionId = ''
    currentRun.value = undefined
    stopRunLifecycle?.()
    stopRunLifecycle = undefined
    window.clearTimeout(sessionsRefreshTimer)
    sessionsRefreshTimer = undefined
    clearActiveRuns()
    pendingLocalSessions.clear()
    localRunIds.clear()
  }

  function finishRunEffects(targetSessionId: string) {
    if (sessionId.value === targetSessionId) currentRun.value = undefined
    void (async () => {
      scheduleSessionsRefresh()
      await refreshSessionMessagesIfActive(targetSessionId)
      await options.onRunFinished?.(targetSessionId)
    })()
  }

  function handleRunEvent(targetSessionId: string, event: AgentEvent) {
    const reduction = reduceRunEvent(ensureRunState(targetSessionId), event)
    if (!reduction.accepted) return
    sessionRunStates[targetSessionId] = reduction.state

    if (reduction.effects.answerDelta) {
      streamingTextBuffer.append(targetSessionId, reduction.effects.answerDelta)
    }

    if (event.type === 'ask_user.answered' && submittingAskId.value === event.payload.ask_id) {
      submittingAskId.value = ''
    } else if (event.type === 'approval.resolved' && submittingApprovalId.value === event.payload.approval_id) {
      submittingApprovalId.value = ''
    }

    if (reduction.effects.message) {
      const doneMessage = reduction.effects.message
      if (
        doneMessage
        && sessionId.value === targetSessionId
        && !messages.value.some((message) => message.id === doneMessage.id)
      ) {
        messages.value.push(doneMessage)
      }
      if (options.isFinalAssistantMessage(doneMessage)) streamingTextBuffer.clear(targetSessionId)
    }

    if (reduction.effects.finish) finishRunEffects(targetSessionId)
  }

  async function reconcileRun(targetSessionId: string, run: RunHandle) {
    try {
      const snapshot = await run.get()
      if (sessionId.value !== targetSessionId || currentRun.value?.id !== run.id) return
      const state = ensureRunState(targetSessionId)
      if (isTerminalRunStatus(snapshot.status)) {
        finishRunState(state)
        scheduleSessionsRefresh()
        await refreshSessionMessagesIfActive(targetSessionId)
        return
      }
      connectRun(state, run.id, snapshot.pending_ask, snapshot.pending_approval)
    } catch {
      const state = sessionRunStates[targetSessionId]
      if (state?.runId === run.id) setRunError(state, uiText.app.responseFailed)
    }
  }

  async function selectAskOption(option: AskOption) {
    const targetSessionId = sessionId.value
    const state = sessionRunStates[targetSessionId]
    const ask = state ? pendingAskFrom(state) : null
    const run = currentRun.value
    if (!ask || !run || run.id !== state?.runId) return
    if (submittingAskId.value === ask.ask_id) return

    const targetRunId = run.id
    submittingAskId.value = ask.ask_id

    try {
      await run.answer({ requestId: ask.ask_id, optionId: option.id })
      const currentState = sessionRunStates[targetSessionId]
      if (
        currentState?.runId === targetRunId
        && currentState.lifecycle.status === 'awaiting-user'
        && currentState.lifecycle.ask.ask_id === ask.ask_id
      ) {
        resumeRun(currentState)
      }
    } catch (error) {
      if (error instanceof AgentApiError && error.code === 'ASK_NOT_PENDING') {
        await reconcileRun(targetSessionId, run)
      } else {
        const currentState = sessionRunStates[targetSessionId]
        if (currentState?.runId === targetRunId && pendingAskFrom(currentState)?.ask_id === ask.ask_id) {
          setRunError(currentState, uiText.app.responseFailed)
        }
      }
    } finally {
      if (submittingAskId.value === ask.ask_id) submittingAskId.value = ''
    }
  }

  async function decideApproval(decision: 'approved' | 'rejected', scope: 'once' | 'session' | 'persistent' = 'session') {
    const targetSessionId = sessionId.value
    const state = sessionRunStates[targetSessionId]
    const approval = state ? pendingApprovalFrom(state) : null
    const run = currentRun.value
    if (!state || !approval || !run || run.id !== state.runId) return
    if (submittingApprovalId.value === approval.approval_id) return
    const targetRunId = run.id
    submittingApprovalId.value = approval.approval_id

    try {
      await run.approve({
        requestId: approval.approval_id,
        decision,
        scope,
        message: decision === 'rejected' ? 'User rejected the action' : undefined,
      })
      const currentState = sessionRunStates[targetSessionId]
      if (
        currentState?.runId === targetRunId
        && currentState.lifecycle.status === 'awaiting-approval'
        && currentState.lifecycle.approval.approval_id === approval.approval_id
      ) {
        resumeRun(currentState)
      }
    } catch (error) {
      if (error instanceof AgentApiError && error.code === 'APPROVAL_NOT_PENDING') {
        await reconcileRun(targetSessionId, run)
      } else {
        const currentState = sessionRunStates[targetSessionId]
        if (currentState?.runId === targetRunId && pendingApprovalFrom(currentState)?.approval_id === approval.approval_id) {
          setRunError(currentState, uiText.app.responseFailed)
        }
      }
    } finally {
      if (submittingApprovalId.value === approval.approval_id) submittingApprovalId.value = ''
    }
  }

  async function cancelRun() {
    const targetSessionId = sessionId.value
    const state = sessionRunStates[targetSessionId]
    const run = currentRun.value
    if (!state?.runId || !run || run.id !== state.runId || !isRunActive(state)) return
    const targetRunId = run.id
    try {
      await run.cancel()
    } catch {
      const currentState = sessionRunStates[targetSessionId]
      if (currentState?.runId === targetRunId && isRunActive(currentState)) {
        setRunError(currentState, uiText.app.responseFailed)
      }
    }
  }

  return {
    cancelRun,
    archiveSession,
    checkServer,
    createSession,
    decideApproval,
    disposeAgentSession,
    events,
    forkSession,
    isRunning,
    isSubmittingApproval,
    isSubmittingAsk,
    loadSessions,
    loadSessionMessages,
    messages,
    pendingApproval,
    pendingAsk,
    pinSession,
    renameSession,
    runError,
    runId,
    runningSessionIds,
    selectAskOption,
    selectSession,
    sendMessage,
    serverStatus,
    sessionId,
    sessions,
    sortedSessions,
    streamingText,
  }
}

function isTerminalRunStatus(status: RunLifecycleEvent['type']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout'
}
