<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import ActivityPanel from './components/ActivityPanel.vue'
import BrowserPanel from './components/BrowserPanel.vue'
import ChatHeader from './components/ChatHeader.vue'
import ComposerBox from './components/ComposerBox.vue'
import ConversationView from './components/ConversationView.vue'
import SidebarPanel from './components/SidebarPanel.vue'
import { useAgentSession } from './composables/useAgentSession'
import { useBrowserWorkspace } from './composables/useBrowserWorkspace'
import { isVisibleMessage, summarizeOutput, useConversationDisplay } from './composables/useConversationDisplay'
import { useResizablePanels } from './composables/useResizablePanels'
import type { AgentEvent, Message, SessionSummary, TaskTemplate, TraceStep } from './types/conversation'

const input = ref('')
const browserPanel = ref<InstanceType<typeof BrowserPanel> | null>(null)
const composerBox = ref<InstanceType<typeof ComposerBox> | null>(null)
const conversationView = ref<InstanceType<typeof ConversationView> | null>(null)
const copiedKey = ref('')
const processCollapsed = ref<Record<string, boolean>>({})
const {
  closeSidebar,
  closeTransientPanels,
  disposeResizablePanels,
  handleGlobalKeydown,
  handleSidebarResizeKeydown,
  handleWindowResize,
  handleWorkspaceResizeKeydown,
  initResizablePanels,
  openSidebar,
  openWorkspace,
  shellStyle,
  sidebarCollapsed,
  sidebarOpen,
  sidebarResizing,
  startSidebarResize,
  startWorkspaceResize,
  toggleWorkspace,
  traceCollapsed,
  workspaceResizing,
} = useResizablePanels()
const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === 'tauri.localhost' ? 'http://127.0.0.1:4010' : '')
const {
  cancelRun,
  checkServer,
  closeEventSource,
  createSession,
  decideApproval,
  events,
  isRunning,
  loadSessions,
  messages,
  pendingApproval,
  pendingAsk,
  runError,
  runId,
  selectAskOption,
  selectSession: selectAgentSession,
  sendMessage,
  serverStatus,
  sessionId,
  sessions,
  sortedSessions,
  streamingText,
} = useAgentSession({
  apiBase,
  isFinalAssistantMessage,
  onAskUserRequired: () => {
    input.value = ''
    void nextTick(resizeComposer)
  },
  onMessagesLoaded: async () => {
    resizeComposer()
    conversationView.value?.scrollToBottom(true)
  },
})
const {
  disposeBrowserWorkspace,
  initBrowserWorkspace,
  openLinkInBrowser,
} = useBrowserWorkspace({
  apiBase,
  openUrl: async (url) => {
    await nextTick()
    if (!browserPanel.value) throw new Error('Browser panel is not mounted')
    await browserPanel.value.openUrl(url)
  },
  openWorkspace,
})
const taskTemplates: TaskTemplate[] = [
  {
    title: '看看当前项目结构',
    description: '了解项目组成和关键文件',
    prompt: '帮我看看当前项目结构，先总结它是做什么的，再列出我接下来最该看的文件。',
  },
  {
    title: '打开网页并总结重点',
    description: '读取当前浏览器页面',
    prompt: '打开当前浏览器页面，帮我总结重点内容。',
  },
  {
    title: '找一下最近改过的文件',
    description: '辅助定位变更影响',
    prompt: '帮我找一下项目里最近改过的文件，并简要说明可能影响了哪些功能。',
  },
  {
    title: '帮我检查这段报错',
    description: '分析原因和最小修复',
    prompt: '帮我检查这段报错，先分析原因，再给出最小修复方案。',
  },
]
const traceSteps = computed(() => events.value.map(toTraceStep).filter((step): step is TraceStep => Boolean(step)))
const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentTitle = computed(() => currentSession.value?.preview || '新会话')
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
const progressPanelSummary = computed(() => {
  if (pendingApproval.value) return '需要确认'
  if (pendingAsk.value) return '等待回应'
  if (runError.value) return '遇到问题'
  if (toolSummary.value) return isRunning.value ? `正在${toolSummary.value}` : '刚刚完成'
  if (isRunning.value) return '处理中'
  return '待命'
})
const {
  displayItems,
  lastAssistantMessage,
  toggleProcessGroup,
  visibleMessages,
} = useConversationDisplay({
  messages,
  events,
  isRunning,
  pendingAsk,
  pendingApproval,
  runError,
  processCollapsed,
  toolLabels,
  formatTimelineTime,
})
const showResultActions = computed(() => Boolean(lastAssistantMessage.value) && !isRunning.value && !pendingAsk.value && !pendingApproval.value)
const conversationScrollKey = computed(() => `${messages.value.length}:${events.value.length}:${streamingText.value.length}`)
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

  const date = new Date(time)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

  if (targetDay === today) {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  }

  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(date)

  if (date.getFullYear() === now.getFullYear()) return dateLabel

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
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
  composerBox.value?.resize()
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

async function selectSession(id: string) {
  conversationView.value?.resetAutoScroll()
  if (await selectAgentSession(id)) closeTransientPanels()
}

async function startNewSession() {
  if (isRunning.value) return
  if (await createSession()) closeTransientPanels()
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

  void submitMessage()
}

async function submitMessage() {
  const content = input.value.trim()
  if (!content || isRunning.value) return

  input.value = ''
  await nextTick()
  resizeComposer()

  if (await sendMessage(content)) return

  input.value = content
  await nextTick()
  resizeComposer()
}
onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('resize', handleWindowResize)
  initBrowserWorkspace()
  initResizablePanels()

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
  window.removeEventListener('resize', handleWindowResize)
  disposeBrowserWorkspace()
  disposeResizablePanels()
  closeEventSource()
})
</script>

<template>
  <main class="shell" :class="{ 'trace-collapsed': traceCollapsed, 'sidebar-open': sidebarOpen, 'sidebar-collapsed': sidebarCollapsed, 'sidebar-resizing': sidebarResizing, 'workspace-resizing': workspaceResizing }" :style="shellStyle">
    <button v-if="sidebarOpen" class="sidebar-scrim" type="button" aria-label="关闭会话列表"
      @click="closeSidebar"></button>
    <SidebarPanel :sessions="sortedSessions" :active-session-id="sessionId"
      :disabled="serverStatus !== 'online' || isRunning" :is-running="isRunning" :session-label="sessionLabel"
      :session-meta="sessionMeta" @close="closeSidebar" @new-session="startNewSession"
      @select-session="selectSession" />
    <div
      class="sidebar-resizer"
      role="separator"
      aria-label="调整会话列表宽度"
      aria-orientation="vertical"
      tabindex="0"
      @keydown="handleSidebarResizeKeydown"
      @pointerdown="startSidebarResize"
    ></div>

    <section class="chat">
      <ChatHeader
        :title="currentTitle"
        :subtitle="sessionSubtitle"
        :trace-collapsed="traceCollapsed"
        :server-status="serverStatus"
        :server-status-label="serverStatusLabel"
        @open-sidebar="openSidebar"
        @toggle-workspace="toggleWorkspace"
      />

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

      <ConversationView
        ref="conversationView"
        :copied-key="copiedKey"
        :display-items="displayItems"
        :last-assistant-content="lastAssistantMessage?.content || ''"
        :scroll-key="conversationScrollKey"
        :show-empty-state="showEmptyState"
        :show-result-actions="showResultActions"
        :show-thinking="showThinking"
        :streaming-text="streamingText"
        :task-templates="taskTemplates"
        :timeline-note="timelineNote"
        @apply-suggestion="applySuggestion"
        @copy-message="copyMessage($event.key, $event.content)"
        @open-link="openLinkInBrowser"
        @toggle-process-group="toggleProcessGroup"
      />
      <ComposerBox ref="composerBox" :input-value="input" :pending-ask="pendingAsk" :primary-disabled="primaryDisabled"
        :primary-is-stop="primaryIsStop" @update:input-value="input = $event" @input="handleInput"
        @enter="sendOnEnter" @submit="handlePrimaryAction" @select-ask-option="selectAskOption" />
    </section>

    <div
      class="workspace-resizer"
      role="separator"
      aria-label="调整工作区宽度"
      aria-orientation="vertical"
      tabindex="0"
      @keydown="handleWorkspaceResizeKeydown"
      @pointerdown="startWorkspaceResize"
    ></div>

    <aside class="workspace">
      <!-- Progress panel switching is disabled for now; the right workspace only hosts the browser. -->
      <ActivityPanel v-if="false" :steps="traceSteps" :summary="progressPanelSummary" />
      <BrowserPanel ref="browserPanel" :active="!traceCollapsed" />
    </aside>
  </main>
</template>
