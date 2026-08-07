import { computed, nextTick, reactive, ref, shallowRef } from 'vue'
import type { RunHandle, RunLifecycleEvent, SendMessageEnvironmentInput } from '@moke/agent-sdk'
import { createLatestRequestGuard } from '../services/latestRequest'
import type { AgentEvent, ApprovalMode, AskOption, FileAttachmentInput, ImageAttachment, Message } from '../model/conversation'
import { uiText } from '../../../text/uiText'
import { AgentApiError, createAgentApi, type AgentApi } from '../api/agentApi'
import { appendOptimisticUserMessage } from '../model/optimisticMessages'
import { reduceRunEvent } from '../model/runEventReducer'
import {
  connectRun,
  createSessionRunState,
  finishRunState,
  isRunActive,
  pendingApprovalFrom,
  pendingAskFrom,
  resumeRun,
  setRunError,
  startRun,
  type SessionRunState,
} from '../model/runState'
import { createStreamingTextBuffer } from '../services/streamingTextBuffer'
import { useRunSubscriptions } from './useRunSubscriptions'
import { useSessionCatalog } from './useSessionCatalog'

type UseAgentSessionOptions = {
  apiBase: string
  api?: AgentApi
  isFinalAssistantMessage: (message: Message | undefined) => boolean
  onMessagesLoaded?: () => void | Promise<void>
  onRunFinished?: (sessionId: string) => void | Promise<void>
  onSessionCreated?: (sessionId: string) => void
}

export type NewSessionDraft = {
  approval_mode: ApprovalMode
  workspace?: { root: string }
}

export type MessageSubmissionError = {
  code: 'SESSION_CREATE_FAILED' | 'MESSAGE_SEND_FAILED'
  message: string
}

export type SendMessageInput = {
  content: string
  attachments?: ImageAttachment[]
  files?: FileAttachmentInput[]
  env?: SendMessageEnvironmentInput
}

export function useAgentSession(options: UseAgentSessionOptions) {
  const sessionId = ref('')
  const messages = ref<Message[]>([])
  const serverStatus = ref<'checking' | 'online' | 'offline'>('checking')
  const submittingAskId = ref('')
  const submittingApprovalId = ref('')
  const newSessionDraft = reactive<NewSessionDraft>({ approval_mode: 'manual' })
  const submissionError = ref<MessageSubmissionError | null>(null)
  const sessionRunStates = reactive<Record<string, SessionRunState>>({})
  const currentRun = shallowRef<RunHandle>()
  const sessionLoadGuard = createLatestRequestGuard()
  const api = options.api || createAgentApi(options.apiBase)
  let sessionsRefreshTimer: number | undefined
  let messageSubmissionInFlight = false
  const streamingTextBuffer = createStreamingTextBuffer({
    onFlush: (targetSessionId, text) => {
      ensureRunState(targetSessionId).streamingText = text
    },
  })
  const subscriptions = useRunSubscriptions({
    api,
    sessionId,
    sessionRunStates,
    currentRun,
    streamingTextBuffer,
    onEvent: handleRunEvent,
    onExternalRun: (targetSessionId) => { void refreshSessionMessagesIfActive(targetSessionId) },
    onActiveRun: () => scheduleSessionsRefresh(),
    onTerminalRun: () => scheduleSessionsRefresh(),
    reconnectingMessage: uiText.app.reconnecting,
    disconnectedMessage: uiText.app.disconnectedFromMoke,
  })
  const { activeRuns, pendingLocalSessions, localRunIds } = subscriptions
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
  const runError = computed(() => submissionError.value?.message || currentRunState.value.error)
  const runningSessionIds = computed(() =>
    Object.keys(activeRuns),
  )

  function ensureRunState(targetSessionId: string) {
    if (!sessionRunStates[targetSessionId]) sessionRunStates[targetSessionId] = createSessionRunState()
    return sessionRunStates[targetSessionId]
  }

  function resetRunState(targetSessionId: string) {
    streamingTextBuffer.clear(targetSessionId)
    delete sessionRunStates[targetSessionId]
  }

  const catalog = useSessionCatalog({
    api,
    isOnline: () => serverStatus.value === 'online',
    ensureOnline: checkServer,
    isSessionRunning: (targetSessionId) => Boolean(sessionRunStates[targetSessionId] && isRunActive(sessionRunStates[targetSessionId])),
  })
  const { sessions, sortedSessions, loadSessions, updateSession, renameSession, pinSession } = catalog

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
          subscriptions.start()
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

  function resetNewSessionDraft() {
    newSessionDraft.approval_mode = 'manual'
    delete newSessionDraft.workspace
  }

  function startNewSession() {
    if (messageSubmissionInFlight) return false
    submissionError.value = null
    sessionLoadGuard.cancel()
    sessionId.value = ''
    messages.value = []
    subscriptions.watch('')
    resetNewSessionDraft()
    return true
  }

  async function createSessionFromDraft() {
    const env = {
      approval_mode: newSessionDraft.approval_mode,
      ...(newSessionDraft.workspace ? { workspace: { ...newSessionDraft.workspace } } : {}),
    }
    const nextSessionId = await api.createSession(uiText.app.newChat, env)

    sessionId.value = nextSessionId
    messages.value = []
    resetRunState(nextSessionId)
    subscriptions.watch(nextSessionId)
    options.onSessionCreated?.(nextSessionId)
    await loadSessions()
    return nextSessionId
  }

  async function setApprovalMode(approvalMode: ApprovalMode) {
    const targetSessionId = sessionId.value
    if (!targetSessionId) {
      newSessionDraft.approval_mode = approvalMode
      submissionError.value = null
      return true
    }
    if (serverStatus.value !== 'online') return false
    try {
      await api.updateSessionEnvironment(targetSessionId, { approval_mode: approvalMode })
      await loadSessions()
      return true
    } catch {
      return false
    }
  }

  function setDraftWorkspace(root: string) {
    if (sessionId.value || messageSubmissionInFlight) return false
    submissionError.value = null
    const normalizedRoot = root.trim()
    if (normalizedRoot) {
      newSessionDraft.workspace = { root: normalizedRoot }
    } else {
      delete newSessionDraft.workspace
    }
    return true
  }

  async function archiveSession(id: string) {
    if (!(await updateSession(id, { archived: true }))) return false
    resetRunState(id)
    if (id !== sessionId.value) return true

    const nextSession = sortedSessions.value.find((session) => session.id !== id)
    if (nextSession) return loadSessionMessages(nextSession.id)

    sessionId.value = ''
    messages.value = []
    subscriptions.watch('')
    submissionError.value = null
    resetNewSessionDraft()
    return true
  }

  async function loadSessionMessages(id: string, optionsOverride: { notify?: boolean } = {}) {
    const request = sessionLoadGuard.start()

    try {
      const loadedMessages = await api.loadSessionMessages(id, request.signal)
      if (!request.isCurrent()) return false

      sessionId.value = id
      messages.value = loadedMessages
      subscriptions.watch(id)
      submissionError.value = null
      resetNewSessionDraft()

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
    if (messageSubmissionInFlight) return false
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
    submissionError.value = null
    resetRunState(forked.sessionId)
    subscriptions.watch(forked.sessionId)
    await nextTick()
    await options.onMessagesLoaded?.()
    return true
  }

  async function sendMessage(input: string | SendMessageInput) {
    const draft = typeof input === 'string' ? { content: input } : input
    const trimmedContent = draft.content.trim()
    const attachments = draft.attachments || []
    const files = draft.files || []
    if ((!trimmedContent && !attachments.length && !files.length) || isRunning.value || messageSubmissionInFlight) return false

    const startedAsDraft = !sessionId.value
    let createdSessionForSend = false
    submissionError.value = null
    messageSubmissionInFlight = true
    try {
      if (serverStatus.value !== 'online' && !(await checkServer())) {
        submissionError.value = startedAsDraft
          ? { code: 'SESSION_CREATE_FAILED', message: uiText.app.sessionCreateFailed }
          : { code: 'MESSAGE_SEND_FAILED', message: uiText.app.sendFailed }
        return false
      }
      if (!sessionId.value) {
        try {
          await createSessionFromDraft()
          createdSessionForSend = true
        } catch {
          submissionError.value = {
            code: 'SESSION_CREATE_FAILED',
            message: uiText.app.sessionCreateFailed,
          }
          return false
        }
      }
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
        files,
      })
      pendingLocalSessions.add(targetSessionId)

      try {
        const run = await api.sendMessage(targetSessionId, {
          content: trimmedContent,
          attachments,
          files,
          env: draft.env,
        })

        localRunIds.add(run.id)
        if (currentRun.value?.id !== run.id) currentRun.value = run
        if (state.runId !== run.id || state.lifecycle.status === 'starting') connectRun(state, run.id)
        scheduleSessionsRefresh()
        return true
      } catch {
        const message = createdSessionForSend ? uiText.app.firstMessageSendFailed : uiText.app.sendFailed
        submissionError.value = { code: 'MESSAGE_SEND_FAILED', message }
        finishRunState(state, message)
        optimisticMessage.rollback()
        void checkServer()
        return false
      } finally {
        pendingLocalSessions.delete(targetSessionId)
      }
    } catch {
      submissionError.value = startedAsDraft && !sessionId.value
        ? { code: 'SESSION_CREATE_FAILED', message: uiText.app.sessionCreateFailed }
        : { code: 'MESSAGE_SEND_FAILED', message: uiText.app.sendFailed }
      return false
    } finally {
      messageSubmissionInFlight = false
    }
  }

  function disposeAgentSession() {
    subscriptions.dispose()
    window.clearTimeout(sessionsRefreshTimer)
    sessionsRefreshTimer = undefined
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
    newSessionDraft,
    pendingApproval,
    pendingAsk,
    pinSession,
    renameSession,
    runError,
    runId,
    runningSessionIds,
    selectAskOption,
    setDraftWorkspace,
    setApprovalMode,
    selectSession,
    sendMessage,
    serverStatus,
    sessionId,
    sessions,
    sortedSessions,
    startNewSession,
    streamingText,
    submissionError,
  }
}

function isTerminalRunStatus(status: RunLifecycleEvent['type']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout'
}
