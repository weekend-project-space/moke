import { computed, nextTick, reactive, ref } from 'vue'
import { createLatestRequestGuard } from '../services/latestRequest'
import type { AgentEvent, AskOption, ImageAttachment, Message, ReasoningEffort, SessionSummary } from '../model/conversation'
import { uiText } from '../../../text/uiText'
import { AgentApiError, createAgentApi } from '../api/agentApi'
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
import { createRunEventStream } from '../services/runEventStream'
import { createStreamingTextBuffer } from '../services/streamingTextBuffer'

type UseAgentSessionOptions = {
  apiBase: string
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
  const sessionLoadGuard = createLatestRequestGuard()
  const api = createAgentApi(options.apiBase)
  const streamingTextBuffer = createStreamingTextBuffer({
    onFlush: (targetSessionId, text) => {
      ensureRunState(targetSessionId).streamingText = text
    },
  })
  const runEventStream = createRunEventStream({
    apiBase: options.apiBase,
    onActivity: (targetSessionId) => {
      const state = sessionRunStates[targetSessionId]
      if (!state) return
      markRunConnected(state)
    },
    onEvent: handleRunEvent,
    onReconnecting: (targetSessionId) => {
      const state = sessionRunStates[targetSessionId]
      if (!state || !isRunActive(state)) return
      markRunReconnecting(state, uiText.app.reconnecting)
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
    Object.entries(sessionRunStates)
      .filter(([, state]) => isRunActive(state))
      .map(([id]) => id),
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
    runEventStream.close(targetSessionId)
    streamingTextBuffer.clear(targetSessionId)
    delete sessionRunStates[targetSessionId]
  }

  async function checkServer() {
    serverStatus.value = 'checking'

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if (await api.checkHealth()) {
          serverStatus.value = 'online'
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

  async function loadActiveRuns() {
    if (serverStatus.value !== 'online') return

    let activeRuns
    try {
      activeRuns = await api.listActiveRuns()
    } catch {
      return
    }
    const restoredSessionIds = new Set<string>()

    for (const run of activeRuns) {
      if (!run.session_id || !run.run_id || !run.events_url) continue

      restoredSessionIds.add(run.session_id)
      const state = ensureRunState(run.session_id)

      if (state.runId !== run.run_id) {
        runEventStream.close(run.session_id)
        state.runId = run.run_id
        state.events = []
        streamingTextBuffer.clear(run.session_id)
        state.seenEventKeys.clear()
      }

      connectRun(state, run.run_id, run.pending_ask, run.pending_approval)

      runEventStream.subscribe(run.session_id, run.events_url)
    }

    for (const [targetSessionId, state] of Object.entries(sessionRunStates)) {
      if (!isRunActive(state)) continue
      if (restoredSessionIds.has(targetSessionId)) continue

      finishRunState(state)
      runEventStream.close(targetSessionId)
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

    try {
      const run = await api.sendMessage(targetSessionId, {
        content: trimmedContent,
        attachments,
        reasoningEffort: draft.options?.reasoningEffort,
      })

      connectRun(state, run.runId)
      void loadSessions()
      runEventStream.subscribe(targetSessionId, run.eventsUrl)
      return true
    } catch {
      finishRunState(state, uiText.app.sendFailed)
      optimisticMessage.rollback()
      void checkServer()
      return false
    }
  }

  function closeEventSource(targetSessionId?: string) {
    if (targetSessionId) runEventStream.close(targetSessionId)
    else runEventStream.closeAll()
  }

  function finishRunEffects(targetSessionId: string) {
    runEventStream.close(targetSessionId)
    void (async () => {
      await loadSessions()
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
      if (doneMessage && sessionId.value === targetSessionId) messages.value.push(doneMessage)
      if (options.isFinalAssistantMessage(doneMessage)) streamingTextBuffer.clear(targetSessionId)
    }

    if (reduction.effects.finish) finishRunEffects(targetSessionId)
  }

  async function selectAskOption(option: AskOption) {
    const targetSessionId = sessionId.value
    const state = sessionRunStates[targetSessionId]
    const ask = state ? pendingAskFrom(state) : null
    if (!ask || !state.runId) return
    if (submittingAskId.value === ask.ask_id) return

    const targetRunId = state.runId
    submittingAskId.value = ask.ask_id

    try {
      await api.choose(targetRunId, ask.ask_id, option.id)
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
        await loadActiveRuns()
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
    if (!state || !approval || !state.runId) return
    if (submittingApprovalId.value === approval.approval_id) return
    const targetRunId = state.runId
    submittingApprovalId.value = approval.approval_id

    try {
      await api.approve(targetRunId, approval.approval_id, decision, scope)
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
        await loadActiveRuns()
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
    if (!state?.runId || !isRunActive(state)) return
    const targetRunId = state.runId
    try {
      await api.cancel(targetRunId)
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
    closeEventSource,
    createSession,
    decideApproval,
    events,
    forkSession,
    isRunning,
    isSubmittingApproval,
    isSubmittingAsk,
    loadSessions,
    loadActiveRuns,
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
