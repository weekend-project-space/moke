<script setup lang="ts">
import DOMPurify from 'dompurify'
import { PanelRightClose, PanelRightOpen, SendHorizontal, Square } from 'lucide-vue-next'
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
}

type SessionSummary = {
  id: string
  title: string
  created_at: string
  updated_at: string
  preview?: string
  message_count?: number
}

type TraceStep = {
  id: string
  kind: string
  title: string
  detail: string
  meta: string
}

const sessionId = ref('')
const runId = ref('')
const input = ref('检查当前项目，并告诉我下一步应该做什么')
const messages = ref<Message[]>([])
const sessions = ref<SessionSummary[]>([])
const events = ref<AgentEvent[]>([])
const streamingText = ref('')
const pendingApproval = ref<any | null>(null)
const isRunning = ref(false)
const traceCollapsed = ref(true)
const composerInput = ref<HTMLTextAreaElement | null>(null)
const serverStatus = ref<'checking' | 'online' | 'offline'>('checking')
const statusText = computed(() => {
  if (serverStatus.value === 'checking') return '连接中'
  if (serverStatus.value === 'offline') return '服务离线'
  if (pendingApproval.value) return '等待确认'
  if (isRunning.value) return '运行中'
  return '就绪'
})
const traceSteps = computed(() => events.value.map(toTraceStep).filter((step): step is TraceStep => Boolean(step)))
const sortedSessions = computed(() =>
  [...sessions.value].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)),
)
const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentTitle = computed(() => currentSession.value?.preview || currentSession.value?.title || '新会话')
const primaryDisabled = computed(() => {
  if (isRunning.value) return !runId.value
  return serverStatus.value !== 'online' || !input.value.trim()
})
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

  if (output.path) {
    return `Read ${output.path}${output.truncated ? ' (truncated)' : ''}`
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
    return {
      id: event.id,
      kind: 'tool',
      title: `Tool: ${payload.tool}`,
      detail: compactJson(payload.input || {}),
      meta: payload.risk || meta,
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
}

async function startNewSession() {
  if (isRunning.value) return
  await createSession()
}

function sendOnEnter(event: KeyboardEvent) {
  if (event.shiftKey || isRunning.value) return
  event.preventDefault()
  void sendMessage()
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

  messages.value.push({ role: 'user', content })
  input.value = ''
  await nextTick()
  resizeComposer()
  events.value = []
  streamingText.value = ''
  pendingApproval.value = null
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

      if (event.type === 'agent.message.done') {
        messages.value.push(event.payload.message)
        streamingText.value = ''
      }

      if (event.type === 'agent.done' || event.type === 'agent.error') {
        isRunning.value = false
        source.close()
        void loadSessions()
        void loadSessionMessages(sessionId.value)
      }
    })
  }
}

async function decideApproval(decision: 'approved' | 'rejected') {
  if (!pendingApproval.value || !runId.value) return
  const approval = pendingApproval.value
  pendingApproval.value = null

  await fetch(`${apiBase}/api/runs/${runId.value}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      approval_id: approval.approval_id,
      decision,
      message: decision === 'rejected' ? 'User rejected the action' : undefined,
    }),
  })
}

async function cancelRun() {
  if (!runId.value || !isRunning.value) return
  await fetch(`${apiBase}/api/runs/${runId.value}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'User cancelled' }),
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

      <button class="new-session" type="button" :disabled="serverStatus !== 'online' || isRunning" @click="startNewSession">
        新建会话
      </button>

      <section class="session-list">
        <p>会话</p>
        <button
          v-for="session in sortedSessions"
          :key="session.id"
          class="session"
          :class="{ active: session.id === sessionId }"
          type="button"
          :disabled="isRunning"
          @click="selectSession(session.id)"
        >
          <span>{{ sessionLabel(session) }}</span>
          <small>{{ sessionMeta(session) }}</small>
        </button>
      </section>
    </aside>

    <section class="chat">
      <header class="topbar">
        <div>
          <p>{{ statusText }}</p>
          <h2>{{ currentTitle }}</h2>
        </div>
        <span class="server-pill" :class="serverStatus">
          <i aria-hidden="true"></i>
          {{ serverStatus }}
        </span>
        <button
          class="ghost icon-button"
          type="button"
          :aria-label="traceCollapsed ? '显示运行轨迹' : '收起运行轨迹'"
          :title="traceCollapsed ? '显示运行轨迹' : '收起运行轨迹'"
          @click="traceCollapsed = !traceCollapsed"
        >
          <PanelRightOpen v-if="traceCollapsed" :size="18" stroke-width="2.2" />
          <PanelRightClose v-else :size="18" stroke-width="2.2" />
        </button>
      </header>

      <div class="conversation">
        <article v-for="(message, index) in messages" :key="index" class="bubble" :class="message.role">
          <div v-if="message.role === 'assistant'" class="markdown" v-html="renderMarkdown(message.content)"></div>
          <template v-else>{{ message.content }}</template>
        </article>
        <article v-if="streamingText" class="bubble assistant live">
          <div class="markdown" v-html="renderMarkdown(streamingText)"></div>
        </article>
      </div>

      <form class="composer" @submit.prevent="handlePrimaryAction">
        <textarea
          v-model="input"
          ref="composerInput"
          rows="1"
          placeholder="告诉 Agent 要做什么..."
          @input="handleInput"
          @keydown.enter="sendOnEnter"
        ></textarea>
        <button
          type="submit"
          :class="{ stop: isRunning }"
          :disabled="primaryDisabled"
          :aria-label="isRunning ? '停止运行' : '发送消息'"
          :title="isRunning ? '停止运行' : '发送消息'"
        >
          <Square v-if="isRunning" :size="17" fill="currentColor" stroke-width="2.2" />
          <SendHorizontal v-else :size="19" stroke-width="2.2" />
        </button>
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
