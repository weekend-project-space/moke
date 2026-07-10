import { computed, nextTick, reactive, ref } from 'vue'
import { createLatestRequestGuard } from './latestRequest'
import type { AgentEvent, AskOption, ImageAttachment, Message, PendingApproval, PendingAsk, ReasoningEffort, SessionSummary } from '../types/conversation'
import { uiText } from '../text/uiText'
import { createAgentApi } from '../features/chat/api/agentApi'
import {
  connectRun,
  createSessionRunState,
  finishRunState,
  isRunActive,
  pendingApprovalFrom,
  pendingAskFrom,
  startRun,
  type SessionRunState,
} from '../features/chat/model/runState'
import { createRunEventStream } from '../features/chat/services/runEventStream'

type UseAgentSessionOptions = {
  apiBase: string
  isFinalAssistantMessage: (message: Message | undefined) => boolean
  onAskUserRequired?: () => void
  onMessagesLoaded?: () => void | Promise<void>
  onRunFinished?: (sessionId: string) => void | Promise<void>
}

const STREAM_FLUSH_INTERVAL_MS = 50

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
  const sessionRunStates = reactive<Record<string, SessionRunState>>({})
  const streamBuffers = new Map<string, string>()
  const streamFlushFrames = new Map<string, number>()
  const streamFlushTimers = new Map<string, number>()
  const streamLastFlushAt = new Map<string, number>()
  const sessionLoadGuard = createLatestRequestGuard()
  const api = createAgentApi(options.apiBase)
  const runEventStream = createRunEventStream({
    apiBase: options.apiBase,
    onConnected: (targetSessionId) => {
      const state = sessionRunStates[targetSessionId]
      if (!state) return
      state.connection = 'connected'
      state.error = ''
    },
    onEvent: handleRunEvent,
    onReconnecting: (targetSessionId) => {
      const state = sessionRunStates[targetSessionId]
      if (!state || !isRunActive(state)) return
      state.connection = 'reconnecting'
      state.error = uiText.app.reconnecting
    },
  })

  const emptyRunState = createSessionRunState()
  const currentRunState = computed(() => (sessionId.value ? sessionRunStates[sessionId.value] : undefined) || emptyRunState)
  const runId = computed(() => currentRunState.value.runId)
  const events = computed(() => currentRunState.value.events)
  const streamingText = computed(() => currentRunState.value.streamingText)
  const pendingApproval = computed(() => pendingApprovalFrom(currentRunState.value))
  const pendingAsk = computed(() => pendingAskFrom(currentRunState.value))
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

  function eventKey(event: AgentEvent) {
    return event.id || `${event.seq || ''}:${event.type}:${event.ts || ''}`
  }

  function appendEvent(targetSessionId: string, event: AgentEvent, optionsOverride: { store?: boolean } = {}) {
    const state = ensureRunState(targetSessionId)
    const key = eventKey(event)
    if (state.seenEventKeys.has(key)) return false

    state.seenEventKeys.add(key)
    if (optionsOverride.store !== false) state.events.push(event)
    return true
  }

  function cancelStreamingFlush(targetSessionId: string) {
    const timer = streamFlushTimers.get(targetSessionId)
    if (timer !== undefined) window.clearTimeout(timer)
    streamFlushTimers.delete(targetSessionId)

    const frame = streamFlushFrames.get(targetSessionId)
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    streamFlushFrames.delete(targetSessionId)
  }

  function flushStreamingBuffer(targetSessionId: string) {
    cancelStreamingFlush(targetSessionId)
    const state = sessionRunStates[targetSessionId]
    if (!state) return

    state.streamingText = streamBuffers.get(targetSessionId) || ''
    streamLastFlushAt.set(targetSessionId, performance.now())
  }

  function clearStreamingBuffer(targetSessionId: string) {
    cancelStreamingFlush(targetSessionId)
    streamBuffers.delete(targetSessionId)
    streamLastFlushAt.delete(targetSessionId)
    ensureRunState(targetSessionId).streamingText = ''
  }

  function scheduleStreamingFlush(targetSessionId: string, immediate = false) {
    if (streamFlushTimers.has(targetSessionId) || streamFlushFrames.has(targetSessionId)) return

    const elapsed = performance.now() - (streamLastFlushAt.get(targetSessionId) || 0)
    const delay = immediate ? 0 : Math.max(0, STREAM_FLUSH_INTERVAL_MS - elapsed)

    const scheduleFrame = () => {
      streamFlushTimers.delete(targetSessionId)
      streamFlushFrames.set(targetSessionId, window.requestAnimationFrame(() => flushStreamingBuffer(targetSessionId)))
    }

    if (delay <= 0) {
      scheduleFrame()
      return
    }

    streamFlushTimers.set(targetSessionId, window.setTimeout(scheduleFrame, delay))
  }

  function appendStreamingDelta(targetSessionId: string, content: string) {
    if (!content) return
    streamBuffers.set(targetSessionId, `${streamBuffers.get(targetSessionId) || ''}${content}`)
    scheduleStreamingFlush(targetSessionId)
  }

  function resetRunState(targetSessionId: string) {
    runEventStream.close(targetSessionId)
    clearStreamingBuffer(targetSessionId)
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
        clearStreamingBuffer(run.session_id)
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
    clearStreamingBuffer(targetSessionId)
    startRun(state)
    const optimisticMessage: Message = {
      role: 'user',
      content: trimmedContent,
      created_at: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
    }
    messages.value.push(optimisticMessage)

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
      if (sessionId.value === targetSessionId) {
        const index = messages.value.lastIndexOf(optimisticMessage)
        if (index >= 0) messages.value.splice(index, 1)
      }
      void checkServer()
      return false
    }
  }

  function closeEventSource(targetSessionId?: string) {
    if (targetSessionId) runEventStream.close(targetSessionId)
    else runEventStream.closeAll()
  }

  function finishRun(targetSessionId: string) {
    const state = ensureRunState(targetSessionId)
    finishRunState(state)
    runEventStream.close(targetSessionId)
    void (async () => {
      await loadSessions()
      await refreshSessionMessagesIfActive(targetSessionId)
      await options.onRunFinished?.(targetSessionId)
    })()
  }

  function handleRunEvent(targetSessionId: string, event: AgentEvent) {
    const state = ensureRunState(targetSessionId)

    if (event.type === 'agent.message.delta') {
      const channel = event.payload.channel || 'answer'
      const isAnswerDelta = channel !== 'reasoning'
      if (!appendEvent(targetSessionId, event, { store: !isAnswerDelta })) return
      if (isAnswerDelta) {
        appendStreamingDelta(targetSessionId, event.payload.content || '')
        return
      }
    } else if (!appendEvent(targetSessionId, event)) {
      return
    }

    if (event.type === 'approval.required') {
      state.lifecycle = { status: 'awaiting-approval', approval: event.payload as PendingApproval }
    }

    if (event.type === 'ask_user.required') {
      const ask = event.payload as PendingAsk
      state.lifecycle = { status: 'awaiting-user', ask }
      if (sessionId.value === targetSessionId) {
        options.onAskUserRequired?.()
        messages.value.push({
          role: 'assistant',
          content: ask.question,
          created_at: ask.created_at || event.ts,
        })
      }
    }

    if (event.type === 'agent.message.done') {
      const doneMessage = event.payload.message as Message | undefined
      if (doneMessage && sessionId.value === targetSessionId) messages.value.push(doneMessage)
      if (options.isFinalAssistantMessage(doneMessage)) clearStreamingBuffer(targetSessionId)
    }

    if (event.type === 'agent.done' || event.type === 'agent.error') finishRun(targetSessionId)
  }

  async function selectAskOption(option: AskOption) {
    const targetSessionId = sessionId.value
    const state = sessionRunStates[targetSessionId]
    const ask = state ? pendingAskFrom(state) : null
    if (!ask || !state.runId) return

    const optimisticMessage: Message = { role: 'user', content: option.label, created_at: new Date().toISOString() }
    messages.value.push(optimisticMessage)
    const previousAsk = ask
    state.lifecycle = { status: 'running' }

    try {
      await api.choose(state.runId, ask.ask_id, option.id)
      return
    } catch {
      // Restore the pending question below.
    }

    if (state.runId && state.lifecycle.status === 'running') {
      state.lifecycle = { status: 'awaiting-user', ask: previousAsk }
      state.error = uiText.app.responseFailed
      if (sessionId.value === targetSessionId) {
        const index = messages.value.lastIndexOf(optimisticMessage)
        if (index >= 0) messages.value.splice(index, 1)
      }
    }
  }

  async function decideApproval(decision: 'approved' | 'rejected', scope: 'once' | 'session' | 'persistent' = 'session') {
    const state = sessionRunStates[sessionId.value]
    const approval = state ? pendingApprovalFrom(state) : null
    if (!state || !approval || !state.runId) return
    state.lifecycle = { status: 'running' }

    try {
      await api.approve(state.runId, approval.approval_id, decision, scope)
      return
    } catch {
      // Restore the approval below.
    }

    state.lifecycle = { status: 'awaiting-approval', approval }
    state.error = uiText.app.responseFailed
  }

  async function cancelRun() {
    const state = sessionRunStates[sessionId.value]
    if (!state?.runId || !isRunActive(state)) return
    try {
      await api.cancel(state.runId)
    } catch {
      state.error = uiText.app.responseFailed
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
