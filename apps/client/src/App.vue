<script setup lang="ts">
import DOMPurify from 'dompurify'
import { Check, Copy, Globe2, Menu, PanelRightClose, PanelRightOpen, RotateCcw, Search } from 'lucide-vue-next'
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import ActivityPanel from './components/ActivityPanel.vue'
import BrowserPanel from './components/BrowserPanel.vue'
import ComposerBox from './components/ComposerBox.vue'
import SidebarPanel from './components/SidebarPanel.vue'

type AgentEvent = {
  id: string
  seq: number
  type: string
  ts: string
  payload: Record<string, any>
}

type Message = {
  role: 'user' | 'assistant' | 'tool'
  content: string
  created_at?: string
  tool_calls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
  tool_call_id?: string
  name?: string
  status?: 'success' | 'error'
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
}

type TaskTemplate = {
  title: string
  description: string
  prompt: string
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
const input = ref('')
const messages = ref<Message[]>([])
const sessions = ref<SessionSummary[]>([])
const events = ref<AgentEvent[]>([])
const streamingText = ref('')
const pendingApproval = ref<any | null>(null)
const pendingAsk = ref<PendingAsk | null>(null)
const isRunning = ref(false)
const traceCollapsed = ref(true)
const workspaceView = ref<'activity' | 'browser'>('activity')
const sidebarOpen = ref(false)
const composerBox = ref<InstanceType<typeof ComposerBox> | null>(null)
const serverStatus = ref<'checking' | 'online' | 'offline'>('checking')
const conversationEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const runError = ref('')
const copiedKey = ref('')
let eventSource: EventSource | null = null
const taskTemplates: TaskTemplate[] = [
  {
    title: '整理文件',
    description: '先看一眼，再给出安全整理建议',
    prompt: '帮我看看下载文件夹里哪些文件可以整理。先给建议，不要直接删除或移动文件。',
  },
  {
    title: '查找内容',
    description: '帮你在电脑或项目里找到相关文件',
    prompt: '帮我查找和报销相关的文件，只列出可能相关的位置和文件名。',
  },
  {
    title: '阅读总结',
    description: '读文档或项目，整理重点和下一步',
    prompt: '阅读当前目录，告诉我这个项目是做什么的，并列出我接下来最该看的文件。',
  },
  {
    title: '帮我操作',
    description: '执行前先确认，保留可控感',
    prompt: '帮我完成一个电脑任务。请先说明你准备怎么做，需要修改文件前先问我。',
  },
]
const traceSteps = computed(() => events.value.map(toTraceStep).filter((step): step is TraceStep => Boolean(step)))
const sortedSessions = computed(() =>
  [...sessions.value].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)),
)
const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentTitle = computed(() => currentSession.value?.title || currentSession.value?.preview || '新会话')
const sessionSubtitle = computed(() => {
  if (pendingAsk.value) return '等待回应'
  if (pendingApproval.value) return '等待确认'
  if (isRunning.value) return '处理中'
  return ''
})
const serverStatusLabel = computed(() => {
  const labels = {
    checking: '正在连接',
    online: '已连接',
    offline: '未连接',
  }

  return labels[serverStatus.value]
})
const approvalTool = computed(() => pendingApproval.value?.action?.tool || '待确认操作')
const approvalToolLabel = computed(() => toolLabels[approvalTool.value] || approvalTool.value)
const toolLabels: Record<string, string> = {
  apply_patch: '编辑内容',
  bash: '运行命令',
  cat: '读取文件',
  exec_command: '运行命令',
  find: '查找内容',
  grep: '查找内容',
  ls: '浏览文件',
  npm: '运行检查',
  rg: '查找内容',
  sed: '读取片段',
  view_image: '查看图片',
}
const progressLabels: Record<string, string> = {
  编辑内容: '编辑',
  运行命令: '处理',
  读取文件: '读取',
  查找内容: '查找',
  浏览文件: '浏览',
  运行检查: '检查',
  读取片段: '读取',
  查看图片: '查看',
}
const recentToolNames = computed(() => {
  const names: string[] = []

  for (const event of [...events.value].reverse()) {
    if (event.type !== 'tool.call') continue

    const rawName = String(event.payload.tool || '').trim()
    const name = toolLabels[rawName] || rawName
    if (!name || names.includes(name)) continue

    names.push(name)
  }

  return names
})
const toolSummary = computed(() => {
  const name = recentToolNames.value[0]
  if (!name) return ''

  return progressLabels[name] || name
})
const runSummary = computed(() => {
  if (pendingApproval.value || pendingAsk.value) return '需要处理'
  return workspaceView.value === 'browser' ? '浏览器' : '进展'
})
const progressPanelSummary = computed(() => {
  if (pendingApproval.value) return '需要确认'
  if (pendingAsk.value) return '等待回应'
  if (runError.value) return '遇到问题'
  if (toolSummary.value) return isRunning.value ? `正在${toolSummary.value}` : '刚刚完成'
  if (isRunning.value) return '处理中'
  return '待命'
})
const visibleMessages = computed(() => messages.value.filter(isVisibleMessage))
const lastAssistantMessage = computed(() =>
  [...visibleMessages.value].reverse().find((message) => message.role === 'assistant' && message.content.trim()),
)
const showResultActions = computed(() => Boolean(lastAssistantMessage.value) && !isRunning.value && !pendingAsk.value && !pendingApproval.value)
const displayItems = computed<DisplayItem[]>(() => {
  const items: DisplayItem[] = []
  let lastTime = 0

  visibleMessages.value.forEach((message, index) => {
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
  if (serverStatus.value === 'checking') return '正在连接 Moke'
  if (serverStatus.value === 'offline') return 'Moke 未连接'
  if (runError.value) return runError.value
  if (pendingAsk.value) return 'Moke 正在等待你的回应'
  if (pendingApproval.value) return '需要你确认后继续执行'
  if (isRunning.value) return 'Moke 正在思考和执行'
  return ''
})
const showThinking = computed(
  () => isRunning.value && !streamingText.value && !pendingAsk.value && !pendingApproval.value,
)
const showEmptyState = computed(
  () => serverStatus.value === 'online' && visibleMessages.value.length === 0 && !isRunning.value,
)
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

function isVisibleMessage(message: Message) {
  return message.role !== 'tool' && !message.tool_calls?.length && Boolean(message.content.trim())
}

function isFinalAssistantMessage(message: Message | undefined) {
  return message?.role === 'assistant' && isVisibleMessage(message)
}

function sessionLabel(session: SessionSummary) {
  return session.title || session.preview || '新会话'
}

function sessionMeta(session: SessionSummary) {
  return formatSessionTime(session.updated_at)
}

function formatSessionTime(value: string) {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return '刚刚'

  return formatTimelineTime(time)
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

function scrollToBottom(force = false) {
  const el = conversationEl.value
  if (!el || (!force && !autoScroll.value)) return

  el.scrollTop = el.scrollHeight
}

function handleConversationScroll() {
  const el = conversationEl.value
  if (!el) return

  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

watch(
  () => [messages.value.length, streamingText.value],
  () => {
    void nextTick(() => scrollToBottom())
  },
)

function resizeComposer() {
  composerBox.value?.resize()
}

function summarizeOutput(output: Record<string, any> | undefined) {
  if (!output) return '已完成'
  if (output.error) return String(output.error)

  if (Array.isArray(output.matches)) {
    const count = output.count ?? output.matches.length
    return count > 0 ? `找到 ${count} 条相关内容` : '没有找到相关内容'
  }


  return '已完成'
}

function toTraceStep(event: AgentEvent): TraceStep | null {
  const payload = event.payload

  if (event.type === 'agent.started') {
    return {
      id: event.id,
      kind: 'input',
      title: '理解任务',
      detail: payload.input || 'Moke 正在理解你的任务',
    }
  }

  if (event.type === 'agent.plan') {
    return {
      id: event.id,
      kind: 'plan',
      title: '安排步骤',
      detail: 'Moke 正在决定先看哪里、后做什么',
    }
  }

  if (event.type === 'agent.state') {
    const labels: Record<string, string> = {
      reason: '判断下一步',
      act: '执行一步',
      respond: '整理结果',
    }
    return {
      id: event.id,
      kind: payload.state || 'state',
      title: labels[payload.state] || '继续处理',
      detail: payload.state === 'respond' ? 'Moke 正在把结果整理成你能直接看的内容' : labels[payload.state] || 'Moke 正在继续处理',
    }
  }

  if (event.type === 'tool.call') {
    const title = toolLabels[payload.tool] || '处理内容'

    return {
      id: event.id,
      kind: 'tool',
      title,
      detail: `正在${title}，不会在未确认时做高风险改动`,
    }
  }

  if (event.type === 'tool.result') {
    return {
      id: event.id,
      kind: payload.status === 'ok' ? 'observation' : 'error',
      title: payload.status === 'ok' ? '完成一步' : '处理失败',
      detail: summarizeOutput(payload.output),
    }
  }

  if (event.type === 'approval.required') {
    return {
      id: event.id,
      kind: 'approval',
      title: '等待确认',
      detail: payload.reason || '需要你确认后继续',
    }
  }

  if (event.type === 'ask_user.required') {
    return {
      id: event.id,
      kind: 'ask',
      title: '等待回应',
      detail: payload.question || 'Moke 需要更多信息',
    }
  }

  if (event.type === 'agent.message.done') {
    const message = payload.message as Message | undefined
    if (!isFinalAssistantMessage(message)) return null

    return {
      id: event.id,
      kind: 'final',
      title: '交付结果',
      detail: '已经把结果整理到对话里',
    }
  }

  if (event.type === 'agent.done') {
    return {
      id: event.id,
      kind: 'done',
      title: '完成',
      detail: '这次任务已结束，可以继续追问或复制结果',
    }
  }

  if (event.type === 'agent.error') {
    return {
      id: event.id,
      kind: 'error',
      title: '遇到问题',
      detail: payload.message || '未知问题',
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
    body: JSON.stringify({ title: 'Moke 对话' }),
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
  scrollToBottom()
  return true
}

async function selectSession(id: string) {
  if (id === sessionId.value || isRunning.value) return

  autoScroll.value = true
  if (!(await loadSessionMessages(id))) return

  events.value = []
  streamingText.value = ''
  pendingApproval.value = null
  pendingAsk.value = null
  runError.value = ''
  sidebarOpen.value = false
}

async function startNewSession() {
  if (isRunning.value) return
  await createSession()
  sidebarOpen.value = false
}

function openSidebar() {
  traceCollapsed.value = true
  sidebarOpen.value = true
}

function openWorkspace(view: 'activity' | 'browser') {
  sidebarOpen.value = false
  workspaceView.value = view
  traceCollapsed.value = false
}

function toggleWorkspace() {
  if (traceCollapsed.value) {
    openWorkspace(workspaceView.value)
    return
  }

  traceCollapsed.value = true
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return

  if (sidebarOpen.value) {
    sidebarOpen.value = false
    return
  }

  if (!traceCollapsed.value) traceCollapsed.value = true
}

function sendOnEnter(event: KeyboardEvent) {
  if (event.shiftKey || isRunning.value) return
  event.preventDefault()
  void handlePrimaryAction()
}

function handleInput() {
  resizeComposer()
}

function applySuggestion(prompt: string) {
  input.value = prompt
  void nextTick(() => {
    resizeComposer()
    composerBox.value?.focus()
  })
}

async function copyMessage(key: string, content: string) {
  try {
    await navigator.clipboard.writeText(content)
  } catch {
    const helper = document.createElement('textarea')
    helper.value = content
    document.body.appendChild(helper)
    helper.select()
    document.execCommand('copy')
    helper.remove()
  }

  copiedKey.value = key
  window.setTimeout(() => {
    if (copiedKey.value === key) copiedKey.value = ''
  }, 1500)
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
  runError.value = ''
  isRunning.value = true

  try {
    const response = await fetch(`${apiBase}/api/sessions/${sessionId.value}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { role: 'user', content },
        options: { stream: true },
      }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const data = await response.json()
    if (!data.run_id || !data.events_url) throw new Error('Invalid run response')

    runId.value = data.run_id
    subscribe(data.events_url)
  } catch {
    isRunning.value = false
    runError.value = '发送失败，请确认 Moke 已连接后重试'
    messages.value.pop()
    input.value = content
    await nextTick()
    resizeComposer()
    void checkServer()
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
  const source = new EventSource(`${apiBase}${eventsUrl}`)
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
        const doneMessage = event.payload.message as Message | undefined
        if (doneMessage) {
          messages.value.push(doneMessage)
          if (isFinalAssistantMessage(doneMessage)) streamingText.value = ''
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
  window.addEventListener('keydown', handleGlobalKeydown)

  if (await checkServer()) {
    await loadSessions()
    const latestSession = sortedSessions.value[0]
    if (latestSession) {
      await selectSession(latestSession.id)
    } else {
      await createSession()
    }
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  closeEventSource()
})
</script>

<template>
  <main class="shell" :class="{ 'trace-collapsed': traceCollapsed, 'sidebar-open': sidebarOpen }">
    <button v-if="sidebarOpen" class="sidebar-scrim" type="button" aria-label="关闭会话列表"
      @click="sidebarOpen = false"></button>
    <SidebarPanel :sessions="sortedSessions" :active-session-id="sessionId"
      :disabled="serverStatus !== 'online' || isRunning" :is-running="isRunning" :session-label="sessionLabel"
      :session-meta="sessionMeta" @close="sidebarOpen = false" @new-session="startNewSession"
      @select-session="selectSession" />

    <section class="chat">
      <header class="topbar">
        <button class="sidebar-toggle" type="button" aria-label="显示会话列表" title="显示会话列表" @click="openSidebar">
          <Menu :size="17" stroke-width="2.2" />
        </button>
        <div>
          <h2>{{ currentTitle }}</h2>
          <p v-if="sessionSubtitle">{{ sessionSubtitle }}</p>
        </div>
        <button class="trace-summary" type="button" :class="{ attention: pendingApproval || pendingAsk }"
          :aria-label="traceCollapsed ? '显示工作区' : '收起工作区'" :title="traceCollapsed ? '显示工作区' : '收起工作区'"
          @click="toggleWorkspace">
          {{ runSummary }}
          <PanelRightOpen v-if="traceCollapsed" :size="14" stroke-width="2.2" />
          <PanelRightClose v-else :size="14" stroke-width="2.2" />
        </button>
        <span v-if="serverStatus !== 'online'" class="server-pill" :class="serverStatus">
          <i aria-hidden="true"></i>
          {{ serverStatusLabel }}
        </span>
      </header>

      <section v-if="pendingApproval" class="approval approval-banner">
        <div>
          <p>{{ pendingApproval.reason }}</p>
          <span>{{ approvalToolLabel }} · 需要确认</span>
        </div>
        <menu>
          <button type="button" @click="decideApproval('approved')">允许</button>
          <button type="button" class="secondary" @click="decideApproval('rejected')">拒绝</button>
        </menu>
      </section>

      <div class="conversation" ref="conversationEl" @scroll.passive="handleConversationScroll">
        <div v-if="timelineNote" class="timeline-note">{{ timelineNote }}</div>

        <div v-if="showEmptyState" class="empty-state">
          <div class="empty-kicker">你的电脑任务助手</div>
          <h3>想让 Moke 帮你做什么？</h3>
          <p>先查看、再建议；需要改动时会等你确认。</p>
          <div class="suggestion-grid">
            <button v-for="template in taskTemplates" :key="template.title" type="button"
              @click="applySuggestion(template.prompt)">
              <span>{{ template.title }}</span>
              <small>{{ template.description }}</small>
            </button>
          </div>
        </div>

        <template v-for="item in displayItems" :key="item.id">
          <div v-if="item.type === 'time'" class="timeline-note time-note">{{ item.label }}</div>
          <article v-else class="message-row" :class="item.message.role">
            <div class="bubble" :class="item.message.role">
              <div v-if="item.message.role === 'assistant'" class="markdown"
                v-html="renderMarkdown(item.message.content)"></div>
              <template v-else>{{ item.message.content }}</template>
            </div>
            <button v-if="item.message.role === 'assistant'" class="copy-button" type="button"
              :aria-label="copiedKey === item.id ? '已复制' : '复制内容'" :title="copiedKey === item.id ? '已复制' : '复制内容'"
              @click="copyMessage(item.id, item.message.content)">
              <Check v-if="copiedKey === item.id" :size="14" stroke-width="2.2" />
              <Copy v-else :size="14" stroke-width="2.2" />
            </button>
          </article>
        </template>

        <div v-if="streamingText" class="message-row assistant">
          <article class="bubble assistant">
            <div class="markdown streaming" v-html="renderMarkdown(streamingText)"></div>
          </article>
        </div>
        <div v-else-if="showThinking" class="message-row assistant">
          <article class="bubble assistant thinking" aria-label="Moke 正在思考">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </article>
        </div>
        <div v-if="showResultActions" class="result-actions">
          <button type="button" @click="copyMessage('latest-result', lastAssistantMessage?.content || '')">
            <Copy :size="14" stroke-width="2.2" />
            {{ copiedKey === 'latest-result' ? '已复制' : '复制结果' }}
          </button>
          <button type="button" @click="applySuggestion('基于上面的结果，继续帮我整理成更清晰的下一步。')">
            <RotateCcw :size="14" stroke-width="2.2" />
            继续整理
          </button>
          <button type="button" @click="openWorkspace('activity')">
            <Search :size="14" stroke-width="2.2" />
            查看过程
          </button>
          <button type="button" @click="openWorkspace('browser')">
            <Globe2 :size="14" stroke-width="2.2" />
            打开浏览器
          </button>
        </div>
      </div>

      <ComposerBox ref="composerBox" :input-value="input" :pending-ask="pendingAsk" :primary-disabled="primaryDisabled"
        :primary-is-stop="primaryIsStop" @update:input-value="input = $event" @input="handleInput"
        @enter="sendOnEnter" @submit="handlePrimaryAction" @select-ask-option="selectAskOption" />
    </section>

    <aside class="workspace">
      <header class="workspace-tabs" aria-label="工作区视图">
        <button type="button" :class="{ active: workspaceView === 'activity' }" @click="workspaceView = 'activity'">
          <Search :size="14" stroke-width="2.2" />
          进度
        </button>
        <button type="button" :class="{ active: workspaceView === 'browser' }" @click="workspaceView = 'browser'">
          <Globe2 :size="14" stroke-width="2.2" />
          浏览器
        </button>
      </header>
      <ActivityPanel v-show="workspaceView === 'activity'" :steps="traceSteps" :summary="progressPanelSummary" />
      <BrowserPanel v-show="workspaceView === 'browser'" :active="!traceCollapsed && workspaceView === 'browser'" />
    </aside>
  </main>
</template>
