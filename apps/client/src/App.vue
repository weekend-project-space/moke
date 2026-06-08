<script setup lang="ts">
import DOMPurify from 'dompurify'
import { Mic, Paperclip, PanelRightClose, PanelRightOpen, SendHorizontal, Square, Wrench } from 'lucide-vue-next'
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onMounted, ref } from 'vue'

type AgentEvent = {
  id: string
  seq: number
  type: string
  ts: string
  payload: Record<string, any>
}

type Message = {
  role: 'user' | 'assistant'
  content: string
  created_at?: string
}

type SessionSummary = {
  id: string
  title: string
  created_at: string
  updated_at: string
  preview?: string
  message_count?: number
}

type AskOption = {
  id: string
  label: string
}

type PendingAsk = {
  ask_id: string
  call_id: string
  question: string
  options: AskOption[]
  created_at?: string
}

type TraceStep = {
  id: string
  kind: string
  title: string
  detail: string
  meta: string
}

type DisplayItem =
  | {
    type: 'time'
    id: string
    label: string
  }
  | {
    type: 'message'
    id: string
    message: Message
  }

const MESSAGE_TIME_GAP_MS = 10 * 60 * 1000

const sessionId = ref('')
const runId = ref('')
const input = ref('检查当前项目，并告诉我下一步应该做什么')
const messages = ref<Message[]>([])
const sessions = ref<SessionSummary[]>([])
const events = ref<AgentEvent[]>([])
const streamingText = ref('')
const pendingApproval = ref<any | null>(null)
const pendingAsk = ref<PendingAsk | null>(null)
const isRunning = ref(false)
const traceCollapsed = ref(true)
const composerInput = ref<HTMLTextAreaElement | null>(null)
const serverStatus = ref<'checking' | 'online' | 'offline'>('checking')
const traceSteps = computed(() => events.value.map(toTraceStep).filter((step): step is TraceStep => Boolean(step)))
const sortedSessions = computed(() =>
  [...sessions.value].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)),
)
const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentTitle = computed(() => currentSession.value?.preview || currentSession.value?.title || '新会话')
const displayItems = computed<DisplayItem[]>(() => {
  const items: DisplayItem[] = []
  let lastTime = 0

  messages.value.forEach((message, index) => {
    const time = parseMessageTime(message)
    if (time && (lastTime === 0 || time - lastTime >= MESSAGE_TIME_GAP_MS)) {
      items.push({
        type: 'time',
        id: `time-${index}-${time}`,
        label: formatTimelineTime(time),
      })
      lastTime = time
    }

    items.push({
      type: 'message',
      id: `message-${index}`,
      message,
    })
  })

  return items
})
const timelineNote = computed(() => {
  if (serverStatus.value === 'checking') return '正在连接本地服务'
  if (serverStatus.value === 'offline') return '本地服务离线'
  if (pendingAsk.value) return 'Agent 正在等待你的补充'
  if (pendingApproval.value) return '需要你确认后继续执行'
  if (isRunning.value) return 'Moke 正在思考和执行'
  if (messages.value.length === 0) return '开始一个新任务'
  return ''
})
const primaryDisabled = computed(() => {
  if (isRunning.value) return !runId.value
  return serverStatus.value !== 'online' || !input.value.trim()
})
const primaryIsStop = computed(() => isRunning.value && !pendingAsk.value)
const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === 'tauri.localhost' ? 'http://127.0.0.1:4010' : '')

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const defaultLinkOpen =
  markdown.renderer.rules.link_open ||
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noreferrer')
  return defaultLinkOpen(tokens, index, options, env, self)
}

function renderMarkdown(content: string) {
  return DOMPurify.sanitize(markdown.render(content))
}

function sessionLabel(session: SessionSummary) {
  return session.preview || session.title || '新会话'
}

function sessionMeta(session: SessionSummary) {
  const count = session.message_count || 0
  return count > 0 ? `${count} 条消息` : session.id
}

function parseMessageTime(message: Message) {
  if (!message.created_at) return 0

  const time = Date.parse(message.created_at)
  return Number.isNaN(time) ? 0 : time
}

function formatTimelineTime(time: number) {
  const date = new Date(time)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const timeLabel = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)

  if (targetDay === today) return timeLabel
  if (targetDay === today - 24 * 60 * 60 * 1000) return `昨天 ${timeLabel}`

  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(date)

  if (date.getFullYear() === now.getFullYear()) return `${dateLabel} ${timeLabel}`

  return `${date.getFullYear()}年${dateLabel} ${timeLabel}`
}

function resizeComposer() {
  const input = composerInput.value
  if (!input) return

  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 136)}px`
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function summarizeOutput(output: Record<string, any> | undefined) {
  if (!output) return 'Tool finished.'
  if (output.error) return String(output.error)

  if (Array.isArray(output.matches)) {
    const structured = Array.isArray(output.results) ? output.results : []
    const preview =
      structured.length > 0
        ? structured
          .slice(0, 3)
          .map((match) => `${match.path}${match.line ? `:${match.line}` : ''}`)
          .join(', ')
        : output.matches.slice(0, 3).join(', ')
    return `${output.count ?? output.matches.length} matches${preview ? `: ${preview}` : ''}`
  }


  return compactJson(output).slice(0, 180)
}

function toTraceStep(event: AgentEvent): TraceStep | null {
  const payload = event.payload
  const meta = `#${event.seq}`

  if (event.type === 'agent.started') {
    return {
      id: event.id,
      kind: 'input',
      title: 'Request',
      detail: payload.input || 'Run started.',
      meta,
    }
  }

  if (event.type === 'agent.plan') {
    return {
      id: event.id,
      kind: 'plan',
      title: 'ReAct Runtime',
      detail: `${payload.planner || 'llm'} · ${(payload.tools || []).join(', ')}`,
      meta,
    }
  }

  if (event.type === 'agent.state') {
    const labels: Record<string, string> = {
      reason: 'Choosing next action',
      act: 'Running tool',
      respond: 'Writing final answer',
    }
    return {
      id: event.id,
      kind: payload.state || 'state',
      title: labels[payload.state] || 'State changed',
      detail: payload.state || 'state',
      meta,
    }
  }

  if (event.type === 'tool.call') {
    const source = payload.source || {}
    const sourceMeta = source.type === 'mcp' ? `mcp:${source.server_id || 'unknown'}` : payload.risk || meta

    return {
      id: event.id,
      kind: 'tool',
      title: `Tool: ${payload.tool}`,
      detail: compactJson(payload.input || {}),
      meta: sourceMeta,
    }
  }

  if (event.type === 'tool.result') {
    return {
      id: event.id,
      kind: payload.status === 'ok' ? 'observation' : 'error',
      title: payload.status === 'ok' ? 'Observation' : 'Tool Error',
      detail: summarizeOutput(payload.output),
      meta: `${payload.duration_ms || 0}ms`,
    }
  }

  if (event.type === 'approval.required') {
    return {
      id: event.id,
      kind: 'approval',
      title: 'Approval Required',
      detail: payload.reason || 'Waiting for user decision.',
      meta,
    }
  }

  if (event.type === 'ask_user.required') {
    return {
      id: event.id,
      kind: 'ask',
      title: 'Waiting for User',
      detail: payload.question || 'Agent needs more information.',
      meta,
    }
  }

  if (event.type === 'agent.message.done') {
    return {
      id: event.id,
      kind: 'final',
      title: 'Final Answer',
      detail: payload.message?.content || 'Answer completed.',
      meta,
    }
  }

  if (event.type === 'agent.done') {
    return {
      id: event.id,
      kind: 'done',
      title: 'Run Finished',
      detail: `${payload.status || 'completed'} · ${payload.usage?.tool_calls || 0} tool calls`,
      meta,
    }
  }

  if (event.type === 'agent.error') {
    return {
      id: event.id,
      kind: 'error',
      title: 'Run Error',
      detail: payload.message || 'Unknown error',
      meta,
    }
  }

  return null
}

async function checkServer() {
  serverStatus.value = 'checking'

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${apiBase}/api/health`)
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
  if (serverStatus.value !== 'online' && !(await checkServer())) return

  const response = await fetch(`${apiBase}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Moke Agent' }),
  })
  const data = await response.json()
  sessionId.value = data.session.id
  messages.value = []
  events.value = []
  streamingText.value = ''
  pendingApproval.value = null
  pendingAsk.value = null
  await loadSessions()
}

async function loadSessions() {
  if (serverStatus.value !== 'online') return

  const response = await fetch(`${apiBase}/api/sessions`)
  if (!response.ok) return

  const data = await response.json()
  sessions.value = data.sessions || []
}

async function loadSessionMessages(id: string) {
  const response = await fetch(`${apiBase}/api/sessions/${id}`)
  if (!response.ok) return false

  const data = await response.json()
  sessionId.value = id
  messages.value = data.messages || []
  await nextTick()
  resizeComposer()
  return true
}

async function selectSession(id: string) {
  if (id === sessionId.value || isRunning.value) return

  if (!(await loadSessionMessages(id))) return

  events.value = []
  streamingText.value = ''
  pendingApproval.value = null
  pendingAsk.value = null
}

async function startNewSession() {
  if (isRunning.value) return
  await createSession()
}

function sendOnEnter(event: KeyboardEvent) {
  if (event.shiftKey || isRunning.value) return
  event.preventDefault()
  void handlePrimaryAction()
}

function handleInput() {
  resizeComposer()
}

function handlePrimaryAction() {
  if (isRunning.value) {
    void cancelRun()
    return
  }

  void sendMessage()
}

async function sendMessage() {
  const content = input.value.trim()
  if (!content || isRunning.value) return

  if (serverStatus.value !== 'online' && !(await checkServer())) return
  if (!sessionId.value) await createSession()
  if (!sessionId.value) return

  messages.value.push({ role: 'user', content, created_at: new Date().toISOString() })
  input.value = ''
  await nextTick()
  resizeComposer()
  events.value = []
  streamingText.value = ''
  pendingApproval.value = null
  pendingAsk.value = null
  isRunning.value = true

  const response = await fetch(`${apiBase}/api/sessions/${sessionId.value}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { role: 'user', content },
      options: { stream: true, max_steps: 6 },
    }),
  })
  const data = await response.json()
  runId.value = data.run_id
  subscribe(data.events_url)
}

function subscribe(eventsUrl: string) {
  const source = new EventSource(`${apiBase}${eventsUrl}`)
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
        pendingApproval.value = event.payload
      }

      if (event.type === 'ask_user.required') {
        pendingAsk.value = event.payload as PendingAsk
        input.value = ''
        void nextTick(resizeComposer)
        messages.value.push({
          role: 'assistant',
          content: pendingAsk.value.question,
          created_at: pendingAsk.value.created_at || event.ts,
        })
      }

      if (event.type === 'agent.message.done') {
        messages.value.push(event.payload.message)
        streamingText.value = ''
      }

      if (event.type === 'agent.done' || event.type === 'agent.error') {
        isRunning.value = false
        pendingAsk.value = null
        source.close()
        void loadSessions()
        void loadSessionMessages(sessionId.value)
      }
    })
  }
}

async function selectAskOption(option: AskOption) {
  const ask = pendingAsk.value
  if (!ask || !runId.value) return

  messages.value.push({ role: 'user', content: option.label, created_at: new Date().toISOString() })
  const previousAsk = ask
  pendingAsk.value = null

  const response = await fetch(`${apiBase}/api/runs/${runId.value}/respond`, {
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

async function decideApproval(decision: 'approved' | 'rejected') {
  if (!pendingApproval.value || !runId.value) return
  const approval = pendingApproval.value
  pendingApproval.value = null

  await fetch(`${apiBase}/api/runs/${runId.value}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'approve',
      request_id: approval.approval_id,
      decision,
      message: decision === 'rejected' ? 'User rejected the action' : undefined,
    }),
  })
}

async function cancelRun() {
  if (!runId.value || !isRunning.value) return
  await fetch(`${apiBase}/api/runs/${runId.value}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'cancel', reason: 'User cancelled' }),
  })
}

onMounted(async () => {
  if (await checkServer()) {
    await loadSessions()
    if (sessions.value[0]) {
      await selectSession(sessions.value[0].id)
    } else {
      await createSession()
    }
  }
})
</script>

<template>
  <main class="shell" :class="{ 'trace-collapsed': traceCollapsed }">
    <aside class="sidebar">
      <div class="traffic-lights" aria-hidden="true">
        <span class="red"></span>
        <span class="yellow"></span>
        <span class="green"></span>
      </div>
      <section class="brand">
        <p>Local Agent</p>
        <h1>Moke</h1>
      </section>

      <button class="new-session" type="button" :disabled="serverStatus !== 'online' || isRunning"
        @click="startNewSession">
        新建会话
      </button>

      <section class="session-list">
        <p>会话</p>
        <button v-for="session in sortedSessions" :key="session.id" class="session"
          :class="{ active: session.id === sessionId }" type="button" :disabled="isRunning"
          @click="selectSession(session.id)">
          <span>{{ sessionLabel(session) }}</span>
          <small>{{ sessionMeta(session) }}</small>
        </button>
      </section>
    </aside>

    <section class="chat">
      <header class="topbar">
        <div>
          <h2>{{ currentTitle }}</h2>
          <p>{{ sessionId || '未创建会话' }}</p>
        </div>
        <span class="server-pill" :class="serverStatus">
          <i aria-hidden="true"></i>
          {{ serverStatus }}
        </span>
        <button class="ghost icon-button" type="button" :aria-label="traceCollapsed ? '显示运行轨迹' : '收起运行轨迹'"
          :title="traceCollapsed ? '显示运行轨迹' : '收起运行轨迹'" @click="traceCollapsed = !traceCollapsed">
          <PanelRightOpen v-if="traceCollapsed" :size="18" stroke-width="2.2" />
          <PanelRightClose v-else :size="18" stroke-width="2.2" />
        </button>
      </header>

      <div class="conversation">
        <div v-if="timelineNote" class="timeline-note">{{ timelineNote }}</div>

        <template v-for="item in displayItems" :key="item.id">
          <div v-if="item.type === 'time'" class="timeline-note time-note">{{ item.label }}</div>
          <article v-else class="message-row" :class="item.message.role">
            <div class="bubble" :class="item.message.role">
              <div v-if="item.message.role === 'assistant'" class="markdown"
                v-html="renderMarkdown(item.message.content)"></div>
              <template v-else>{{ item.message.content }}</template>
            </div>
          </article>
        </template>

        <div v-if="streamingText" class="message-row assistant">
          <article class="bubble assistant live">
            <div class="markdown" v-html="renderMarkdown(streamingText)"></div>
          </article>
        </div>
      </div>

      <form class="composer" @submit.prevent="handlePrimaryAction">
        <div class="composer-panel">
          <div v-if="pendingAsk" class="ask-prompt">
            <span>需要补充</span>
            <p>{{ pendingAsk.question }}</p>
            <div class="ask-options">
              <button v-for="option in pendingAsk.options" :key="option.id" type="button"
                @click="selectAskOption(option)">
                {{ option.label }}
              </button>
            </div>
          </div>
          <textarea v-else v-model="input" ref="composerInput" rows="1" placeholder="告诉 Agent 要做什么..."
            @input="handleInput" @keydown.enter="sendOnEnter"></textarea>
          <div v-if="!pendingAsk" class="composer-toolbar">
            <div class="composer-tools">
              <button type="button" disabled aria-label="附件" title="附件">
                <Paperclip :size="17" stroke-width="2.1" />
              </button>
              <button type="button" disabled aria-label="工具" title="工具">
                <Wrench :size="17" stroke-width="2.1" />
              </button>
              <button type="button" disabled aria-label="语音" title="语音">
                <Mic :size="17" stroke-width="2.1" />
              </button>
            </div>
            <button class="primary-action" type="submit" :class="{ stop: primaryIsStop }" :disabled="primaryDisabled"
              :aria-label="primaryIsStop ? '停止运行' : '发送消息'" :title="primaryIsStop ? '停止运行' : '发送消息'">
              <Square v-if="primaryIsStop" :size="16" fill="currentColor" stroke-width="2.2" />
              <SendHorizontal v-else :size="18" stroke-width="2.2" />
            </button>
          </div>
        </div>
      </form>
    </section>

    <aside class="trace">
      <header>
        <p>Run Trace</p>
        <strong>{{ events.length }} events</strong>
      </header>

      <section v-if="pendingApproval" class="approval">
        <p>{{ pendingApproval.reason }}</p>
        <span>{{ pendingApproval.action.tool }} · {{ pendingApproval.risk }}</span>
        <div>
          <button type="button" @click="decideApproval('approved')">Approve</button>
          <button type="button" class="secondary" @click="decideApproval('rejected')">Reject</button>
        </div>
      </section>

      <ol class="events">
        <li v-for="step in traceSteps" :key="step.id" :class="step.kind">
          <div>
            <span>{{ step.title }}</span>
            <p>{{ step.detail }}</p>
          </div>
          <code>{{ step.meta }}</code>
        </li>
      </ol>
    </aside>
  </main>
</template>
