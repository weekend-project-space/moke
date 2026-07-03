import { computed, nextTick, reactive, ref } from 'vue'
import type { AgentEvent, AskOption, Message, PendingApproval, PendingAsk, SessionSummary } from '../types/conversation'

type UseAgentSessionOptions = {
  apiBase: string
  isFinalAssistantMessage: (message: Message | undefined) => boolean
  onAskUserRequired?: () => void
  onMessagesLoaded?: () => void | Promise<void>
}

type SessionRunState = {
  runId: string
  events: AgentEvent[]
  streamingText: string
  pendingApproval: PendingApproval | null
  pendingAsk: PendingAsk | null
  isRunning: boolean
  runError: string
  eventSource: EventSource | null
  seenEventKeys: Set<string>
}

type ActiveRunSummary = {
  session_id: string
  run_id: string
  status: string
  events_url: string
  pending_ask?: PendingAsk
  pending_approval?: PendingApproval
}

function createRunState(runId = ''): SessionRunState {
  return {
    runId,
    events: [],
    streamingText: '',
    pendingApproval: null,
    pendingAsk: null,
    isRunning: false,
    runError: '',
    eventSource: null,
    seenEventKeys: new Set<string>(),
  }
}

export function useAgentSession(options: UseAgentSessionOptions) {
  const sessionId = ref('')
  const messages = ref<Message[]>([])
  const sessions = ref<SessionSummary[]>([])
  const serverStatus = ref<'checking' | 'online' | 'offline'>('checking')
  const sessionRunStates = reactive<Record<string, SessionRunState>>({})

  const emptyRunState = createRunState()
  const currentRunState = computed(() => (sessionId.value ? sessionRunStates[sessionId.value] : undefined) || emptyRunState)
  const runId = computed(() => currentRunState.value.runId)
  const events = computed(() => currentRunState.value.events)
  const streamingText = computed(() => currentRunState.value.streamingText)
  const pendingApproval = computed(() => currentRunState.value.pendingApproval)
  const pendingAsk = computed(() => currentRunState.value.pendingAsk)
  const isRunning = computed(() => currentRunState.value.isRunning)
  const runError = computed(() => currentRunState.value.runError)
  const runningSessionIds = computed(() =>
    Object.entries(sessionRunStates)
      .filter(([, state]) => state.isRunning || state.pendingAsk || state.pendingApproval)
      .map(([id]) => id),
  )

  const sortedSessions = computed(() =>
    [...sessions.value].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return Date.parse(right.updated_at) - Date.parse(left.updated_at)
    }),
  )

  function ensureRunState(targetSessionId: string) {
    if (!sessionRunStates[targetSessionId]) sessionRunStates[targetSessionId] = createRunState()
    return sessionRunStates[targetSessionId]
  }

  function resetRunState(targetSessionId: string) {
    closeEventSource(targetSessionId)
    delete sessionRunStates[targetSessionId]
  }

  function eventKey(event: AgentEvent) {
    return event.id || `${event.seq || ''}:${event.type}:${event.ts || ''}`
  }

  function appendEvent(targetSessionId: string, event: AgentEvent) {
    const state = ensureRunState(targetSessionId)
    const key = eventKey(event)
    if (state.seenEventKeys.has(key)) return false

    state.seenEventKeys.add(key)
    state.events.push(event)
    return true
  }

  async function checkServer() {
    serverStatus.value = 'checking'

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(`${options.apiBase}/api/health`)
        if (response.ok) {
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

    const response = await fetch(`${options.apiBase}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '新对话' }),
    })
    const data = await response.json()
    sessionId.value = data.session.id
    messages.value = []
    resetRunState(sessionId.value)
    await loadSessions()
    return true
  }

  async function loadSessions() {
    if (serverStatus.value !== 'online') return

    const response = await fetch(`${options.apiBase}/api/sessions`)
    if (!response.ok) return

    const data = await response.json()
    sessions.value = data.sessions || []
  }

  async function loadActiveRuns() {
    if (serverStatus.value !== 'online') return

    const response = await fetch(`${options.apiBase}/api/runs/active`)
    if (!response.ok) return

    const data = await response.json()
    const restoredSessionIds = new Set<string>()

    for (const run of (data.runs || []) as ActiveRunSummary[]) {
      if (!run.session_id || !run.run_id || !run.events_url) continue

      restoredSessionIds.add(run.session_id)
      const state = ensureRunState(run.session_id)

      if (state.runId !== run.run_id) {
        state.eventSource?.close()
        state.runId = run.run_id
        state.events = []
        state.streamingText = ''
        state.seenEventKeys.clear()
      }

      state.pendingAsk = run.pending_ask || null
      state.pendingApproval = run.pending_approval || null
      state.runError = ''
      state.isRunning = true

      subscribe(run.events_url, run.session_id)
    }

    for (const [targetSessionId, state] of Object.entries(sessionRunStates)) {
      if (!state.isRunning && !state.pendingAsk && !state.pendingApproval) continue
      if (restoredSessionIds.has(targetSessionId)) continue

      state.isRunning = false
      state.pendingAsk = null
      state.pendingApproval = null
      closeEventSource(targetSessionId)
    }
  }

  async function updateSession(id: string, payload: Record<string, unknown>, optionsOverride: { allowWhileRunning?: boolean } = {}) {
    if (!id || (!optionsOverride.allowWhileRunning && sessionRunStates[id]?.isRunning)) return false
    if (serverStatus.value !== 'online' && !(await checkServer())) return false

    const response = await fetch(`${options.apiBase}/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) return false

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
    const response = await fetch(`${options.apiBase}/api/sessions/${id}`)
    if (!response.ok) return false

    const data = await response.json()
    sessionId.value = id
    messages.value = data.messages || []

    if (optionsOverride.notify !== false) {
      await nextTick()
      await options.onMessagesLoaded?.()
    }
    return true
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

    const response = await fetch(`${options.apiBase}/api/sessions/${sessionId.value}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_id: messageId,
        mode: 'after',
      }),
    })
    if (!response.ok) return false

    const data = await response.json()
    const nextSessionId = data.session?.id
    if (typeof nextSessionId !== 'string') return false

    await loadSessions()
    sessionId.value = nextSessionId
    messages.value = data.messages || []
    resetRunState(nextSessionId)
    await nextTick()
    await options.onMessagesLoaded?.()
    return true
  }

  async function sendMessage(content: string) {
    const trimmedContent = content.trim()
    if (!trimmedContent || isRunning.value) return false

    if (serverStatus.value !== 'online' && !(await checkServer())) return false
    if (!sessionId.value) await createSession()
    if (!sessionId.value) return false

    const targetSessionId = sessionId.value
    const state = ensureRunState(targetSessionId)
    state.events = []
    state.seenEventKeys.clear()
    state.streamingText = ''
    state.pendingApproval = null
    state.pendingAsk = null
    state.runError = ''
    state.isRunning = true
    messages.value.push({ role: 'user', content: trimmedContent, created_at: new Date().toISOString() })

    try {
      const response = await fetch(`${options.apiBase}/api/sessions/${targetSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: { role: 'user', content: trimmedContent },
          options: { stream: true },
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const data = await response.json()
      if (!data.run_id || !data.events_url) throw new Error('Invalid run response')

      state.runId = data.run_id
      void loadSessions()
      subscribe(data.events_url, targetSessionId)
      return true
    } catch {
      state.isRunning = false
      state.runError = '发送失败，请确认 Moke 已连接后重试'
      if (sessionId.value === targetSessionId) messages.value.pop()
      void checkServer()
      return false
    }
  }

  function closeEventSource(targetSessionId?: string) {
    if (targetSessionId) {
      const state = sessionRunStates[targetSessionId]
      state?.eventSource?.close()
      if (state) state.eventSource = null
      return
    }

    for (const state of Object.values(sessionRunStates)) {
      state.eventSource?.close()
      state.eventSource = null
    }
  }

  function finishRun(targetSessionId: string) {
    const state = ensureRunState(targetSessionId)
    state.isRunning = false
    state.pendingAsk = null
    state.pendingApproval = null
    state.eventSource?.close()
    state.eventSource = null
    void loadSessions()
    void refreshSessionMessagesIfActive(targetSessionId)
  }

  function subscribe(eventsUrl: string, targetSessionId: string) {
    closeEventSource(targetSessionId)
    const state = ensureRunState(targetSessionId)
    const source = new EventSource(`${options.apiBase}${eventsUrl}`)
    state.eventSource = source
    const eventTypes = [
      'agent.started',
      'agent.plan',
      'agent.state',
      'agent.message.delta',
      'agent.message.done',
      'tool.call',
      'tool.result',
      'ask_user.required',
      'approval.required',
      'agent.done',
      'agent.error',
    ]

    for (const type of eventTypes) {
      source.addEventListener(type, (message) => {
        const event = JSON.parse((message as MessageEvent).data) as AgentEvent
        if (!appendEvent(targetSessionId, event)) return

        const nextState = ensureRunState(targetSessionId)

        if (event.type === 'agent.message.delta') {
          nextState.streamingText += event.payload.content || ''
        }

        if (event.type === 'approval.required') {
          nextState.pendingApproval = event.payload as PendingApproval
        }

        if (event.type === 'ask_user.required') {
          nextState.pendingAsk = event.payload as PendingAsk
          if (sessionId.value === targetSessionId) {
            options.onAskUserRequired?.()
            messages.value.push({
              role: 'assistant',
              content: nextState.pendingAsk.question,
              created_at: nextState.pendingAsk.created_at || event.ts,
            })
          }
        }

        if (event.type === 'agent.message.done') {
          const doneMessage = event.payload.message as Message | undefined
          if (doneMessage && sessionId.value === targetSessionId) {
            messages.value.push(doneMessage)
          }
          if (options.isFinalAssistantMessage(doneMessage)) nextState.streamingText = ''
        }

        if (event.type === 'agent.done' || event.type === 'agent.error') {
          finishRun(targetSessionId)
        }
      })
    }

    source.onerror = () => {
      const nextState = sessionRunStates[targetSessionId]
      if (!nextState || nextState.eventSource !== source || !nextState.isRunning) {
        source.close()
        return
      }

      nextState.runError = '与 Moke 的连接中断，本次运行已停止'
      finishRun(targetSessionId)
      void checkServer()
    }
  }

  async function selectAskOption(option: AskOption) {
    const targetSessionId = sessionId.value
    const state = sessionRunStates[targetSessionId]
    const ask = state?.pendingAsk
    if (!ask || !state.runId) return

    messages.value.push({ role: 'user', content: option.label, created_at: new Date().toISOString() })
    const previousAsk = ask
    state.pendingAsk = null

    const response = await fetch(`${options.apiBase}/api/runs/${state.runId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'choose',
        request_id: ask.ask_id,
        option_id: option.id,
      }),
    })

    if (!response.ok) {
      state.pendingAsk = previousAsk
      messages.value.pop()
    }
  }

  async function decideApproval(decision: 'approved' | 'rejected', scope: 'once' | 'session' | 'persistent' = 'session') {
    const state = sessionRunStates[sessionId.value]
    if (!state?.pendingApproval || !state.runId) return
    const approval = state.pendingApproval
    state.pendingApproval = null

    await fetch(`${options.apiBase}/api/runs/${state.runId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'approve',
        request_id: approval.approval_id,
        decision,
        scope,
        message: decision === 'rejected' ? 'User rejected the action' : undefined,
      }),
    })
  }

  async function cancelRun() {
    const state = sessionRunStates[sessionId.value]
    if (!state?.runId || !state.isRunning) return
    await fetch(`${options.apiBase}/api/runs/${state.runId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cancel', reason: 'User cancelled' }),
    })
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
