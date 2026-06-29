import { computed, nextTick, ref } from 'vue'
import type { AgentEvent, AskOption, Message, PendingApproval, PendingAsk, SessionSummary } from '../types/conversation'

type UseAgentSessionOptions = {
  apiBase: string
  isFinalAssistantMessage: (message: Message | undefined) => boolean
  onAskUserRequired?: () => void
  onMessagesLoaded?: () => void | Promise<void>
}

export function useAgentSession(options: UseAgentSessionOptions) {
  const sessionId = ref('')
  const runId = ref('')
  const messages = ref<Message[]>([])
  const sessions = ref<SessionSummary[]>([])
  const events = ref<AgentEvent[]>([])
  const streamingText = ref('')
  const pendingApproval = ref<PendingApproval | null>(null)
  const pendingAsk = ref<PendingAsk | null>(null)
  const isRunning = ref(false)
  const serverStatus = ref<'checking' | 'online' | 'offline'>('checking')
  const runError = ref('')
  let eventSource: EventSource | null = null

  const sortedSessions = computed(() =>
    [...sessions.value].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)),
  )

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
      body: JSON.stringify({ title: '新会话' }),
    })
    const data = await response.json()
    sessionId.value = data.session.id
    messages.value = []
    events.value = []
    streamingText.value = ''
    pendingApproval.value = null
    pendingAsk.value = null
    runError.value = ''
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

  async function updateSession(id: string, payload: Record<string, unknown>) {
    if (!id || isRunning.value) return false
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

  async function archiveSession(id: string) {
    if (!(await updateSession(id, { archived: true }))) return false
    if (id !== sessionId.value) return true

    const nextSession = sortedSessions.value.find((session) => session.id !== id)
    if (nextSession) return loadSessionMessages(nextSession.id)

    sessionId.value = ''
    messages.value = []
    events.value = []
    streamingText.value = ''
    pendingApproval.value = null
    pendingAsk.value = null
    runError.value = ''
    return createSession()
  }

  async function loadSessionMessages(id: string) {
    const response = await fetch(`${options.apiBase}/api/sessions/${id}`)
    if (!response.ok) return false

    const data = await response.json()
    sessionId.value = id
    messages.value = data.messages || []
    await nextTick()
    await options.onMessagesLoaded?.()
    return true
  }

  async function selectSession(id: string) {
    if (id === sessionId.value || isRunning.value) return false
    if (!(await loadSessionMessages(id))) return false

    events.value = []
    streamingText.value = ''
    pendingApproval.value = null
    pendingAsk.value = null
    runError.value = ''
    return true
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
    events.value = []
    streamingText.value = ''
    pendingApproval.value = null
    pendingAsk.value = null
    runError.value = ''
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

    messages.value.push({ role: 'user', content: trimmedContent, created_at: new Date().toISOString() })
    events.value = []
    streamingText.value = ''
    pendingApproval.value = null
    pendingAsk.value = null
    runError.value = ''
    isRunning.value = true

    try {
      const response = await fetch(`${options.apiBase}/api/sessions/${sessionId.value}/messages`, {
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

      runId.value = data.run_id
      void loadSessions()
      subscribe(data.events_url)
      return true
    } catch {
      isRunning.value = false
      runError.value = '发送失败，请确认 Moke 已连接后重试'
      messages.value.pop()
      void checkServer()
      return false
    }
  }

  function closeEventSource() {
    eventSource?.close()
    eventSource = null
  }

  function finishRun() {
    isRunning.value = false
    pendingAsk.value = null
    pendingApproval.value = null
    closeEventSource()
    void loadSessions()
    void loadSessionMessages(sessionId.value)
  }

  function subscribe(eventsUrl: string) {
    closeEventSource()
    const source = new EventSource(`${options.apiBase}${eventsUrl}`)
    eventSource = source
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
        events.value.push(event)

        if (event.type === 'agent.message.delta') {
          streamingText.value += event.payload.content || ''
        }

        if (event.type === 'approval.required') {
          pendingApproval.value = event.payload as PendingApproval
        }

        if (event.type === 'ask_user.required') {
          pendingAsk.value = event.payload as PendingAsk
          options.onAskUserRequired?.()
          messages.value.push({
            role: 'assistant',
            content: pendingAsk.value.question,
            created_at: pendingAsk.value.created_at || event.ts,
          })
        }

        if (event.type === 'agent.message.done') {
          const doneMessage = event.payload.message as Message | undefined
          if (doneMessage) {
            messages.value.push(doneMessage)
            if (options.isFinalAssistantMessage(doneMessage)) streamingText.value = ''
          }
        }

        if (event.type === 'agent.done' || event.type === 'agent.error') {
          finishRun()
        }
      })
    }

    source.onerror = () => {
      if (eventSource !== source || !isRunning.value) {
        source.close()
        return
      }

      runError.value = '与 Moke 的连接中断，本次运行已停止'
      finishRun()
      void checkServer()
    }
  }

  async function selectAskOption(option: AskOption) {
    const ask = pendingAsk.value
    if (!ask || !runId.value) return

    messages.value.push({ role: 'user', content: option.label, created_at: new Date().toISOString() })
    const previousAsk = ask
    pendingAsk.value = null

    const response = await fetch(`${options.apiBase}/api/runs/${runId.value}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'choose',
        request_id: ask.ask_id,
        option_id: option.id,
      }),
    })

    if (!response.ok) {
      pendingAsk.value = previousAsk
      messages.value.pop()
    }
  }

  async function decideApproval(decision: 'approved' | 'rejected', scope: 'once' | 'session' | 'persistent' = 'session') {
    if (!pendingApproval.value || !runId.value) return
    const approval = pendingApproval.value
    pendingApproval.value = null

    await fetch(`${options.apiBase}/api/runs/${runId.value}/respond`, {
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
    if (!runId.value || !isRunning.value) return
    await fetch(`${options.apiBase}/api/runs/${runId.value}/respond`, {
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
    loadSessionMessages,
    messages,
    pendingApproval,
    pendingAsk,
    renameSession,
    runError,
    runId,
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
