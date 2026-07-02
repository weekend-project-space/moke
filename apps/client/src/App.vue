<script setup lang="ts">
import { ArrowDown } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import ApprovalInlineBar from './components/ApprovalInlineBar.vue'
import AskInlineBar from './components/AskInlineBar.vue'
import BrowserPanel from './components/BrowserPanel.vue'
import ChatHeader from './components/ChatHeader.vue'
import ComposerBox from './components/ComposerBox.vue'
import ConversationView from './components/ConversationView.vue'
import SettingsPage from './components/SettingsPage.vue'
import SidebarPanel from './components/SidebarPanel.vue'
import { useAgentSession } from './composables/useAgentSession'
import { useBrowserWorkspace } from './composables/useBrowserWorkspace'
import { isVisibleMessage, useConversationDisplay } from './composables/useConversationDisplay'
import { useResizablePanels } from './composables/useResizablePanels'
import type { Message, SessionSummary, TaskTemplate } from './types/conversation'

const input = ref('')
const browserPanel = ref<InstanceType<typeof BrowserPanel> | null>(null)
const composerBox = ref<InstanceType<typeof ComposerBox> | null>(null)
const conversationView = ref<InstanceType<typeof ConversationView> | null>(null)
const copiedKey = ref('')
const showJumpToBottom = ref(false)
const showSettings = ref(false)
const processCollapsed = ref<Record<string, boolean>>({})
const runtimeNow = ref(Date.now())
let runtimeTimer: number | undefined
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
const SESSION_HASH_KEY = 'session'
const {
  cancelRun,
  archiveSession,
  checkServer,
  closeEventSource,
  createSession,
  decideApproval,
  events,
  forkSession,
  isRunning,
  loadActiveRuns,
  loadSessions,
  messages,
  pendingApproval,
  pendingAsk,
  pinSession,
  renameSession,
  runError,
  runId,
  runningSessionIds,
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
const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentTitle = computed(() => {
  if (showSettings.value) return '设置'
  return currentSession.value ? sessionLabel(currentSession.value) : '新会话'
})
const sessionSubtitle = computed(() => {
  if (showSettings.value) return '模型、权限和浏览器'
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
const {
  displayItems,
  lastAssistantMessage,
  toggleProcessGroup,
  visibleMessages,
} = useConversationDisplay({
  messages,
  events,
  isRunning,
  runtimeNow,
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
  if (isRunning.value) return ''
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

function readSessionIdFromHash() {
  const params = new URLSearchParams(window.location.hash.slice(1))
  return params.get(SESSION_HASH_KEY) || ''
}

function writeSessionIdToHash(id: string) {
  const params = new URLSearchParams(window.location.hash.slice(1))
  if (id) {
    params.set(SESSION_HASH_KEY, id)
  } else {
    params.delete(SESSION_HASH_KEY)
  }

  const nextHash = params.toString()
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
}

function initialSessionFromHash() {
  const hashSessionId = readSessionIdFromHash()
  if (!hashSessionId) return sortedSessions.value[0]
  return sortedSessions.value.find((session) => session.id === hashSessionId) || sortedSessions.value[0]
}

function resizeComposer() {
  composerBox.value?.resize()
}

async function selectSession(id: string) {
  conversationView.value?.resetAutoScroll()
  if (await selectAgentSession(id)) {
    showSettings.value = false
    writeSessionIdToHash(id)
    closeTransientPanels()
  }
}

async function startNewSession() {
  if (await createSession()) {
    showSettings.value = false
    writeSessionIdToHash(sessionId.value)
    closeTransientPanels()
  }
}

async function forkMessage(messageId: string) {
  conversationView.value?.resetAutoScroll()
  if (await forkSession(messageId)) {
    showSettings.value = false
    writeSessionIdToHash(sessionId.value)
    closeTransientPanels()
  }
}

async function archiveSelectedSession(id: string) {
  if (await archiveSession(id)) {
    writeSessionIdToHash(sessionId.value)
  }
}

function openSettings() {
  showSettings.value = true
  closeTransientPanels()
}

function closeSettings() {
  showSettings.value = false
}

function sendOnEnter(event: KeyboardEvent) {
  if (event.shiftKey || isRunning.value) return
  event.preventDefault()
  void handlePrimaryAction()
}

function handleInput() {
  resizeComposer()
}

function jumpToConversationBottom() {
  conversationView.value?.jumpToBottom()
  showJumpToBottom.value = false
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

watch(isRunning, (running) => {
  window.clearInterval(runtimeTimer)
  runtimeTimer = undefined
  runtimeNow.value = Date.now()

  if (!running) return

  runtimeTimer = window.setInterval(() => {
    runtimeNow.value = Date.now()
  }, 1000)
})

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('resize', handleWindowResize)
  initBrowserWorkspace()
  initResizablePanels()

  if (await checkServer()) {
    await loadSessions()
    await loadActiveRuns()
    const initialSession = initialSessionFromHash()
    if (initialSession) {
      await selectSession(initialSession.id)
    } else {
      await startNewSession()
    }
  }
})

onUnmounted(() => {
  window.clearInterval(runtimeTimer)
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
      :disabled="serverStatus !== 'online'" :running-session-ids="runningSessionIds" :settings-active="showSettings" :session-label="sessionLabel"
      :session-meta="sessionMeta" @close="closeSidebar" @new-session="startNewSession"
      @select-session="selectSession" @rename-session="renameSession" @archive-session="archiveSelectedSession"
      @pin-session="pinSession" @open-settings="openSettings" />
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

      <SettingsPage
        v-if="showSettings"
        :api-base="apiBase"
        @close="closeSettings"
        @open-browser-url="openLinkInBrowser"
      />
      <ConversationView
        v-else
        ref="conversationView"
        :copied-key="copiedKey"
        :display-items="displayItems"
        :last-assistant-content="lastAssistantMessage?.content || ''"
        :scroll-key="conversationScrollKey"
        :is-running="isRunning"
        :show-empty-state="showEmptyState"
        :show-result-actions="showResultActions"
        :show-thinking="showThinking"
        :streaming-text="streamingText"
        :task-templates="taskTemplates"
        :timeline-note="timelineNote"
        @apply-suggestion="applySuggestion"
        @copy-message="copyMessage($event.key, $event.content)"
        @fork-message="forkMessage"
        @jump-visibility-change="showJumpToBottom = $event"
        @open-link="openLinkInBrowser"
        @toggle-process-group="toggleProcessGroup"
      />
      <button
        v-if="showJumpToBottom && !showSettings"
        class="jump-inline"
        type="button"
        aria-label="跳到底部"
        title="跳到底部"
        @click="jumpToConversationBottom"
      >
        <ArrowDown :size="15" stroke-width="2.2" />
      </button>
      <ApprovalInlineBar
        v-if="pendingApproval && !showSettings"
        :approval="pendingApproval"
        @approve="decideApproval($event.decision, $event.scope)"
      />
      <AskInlineBar v-if="pendingAsk && !showSettings" :ask="pendingAsk" @select="selectAskOption" />
      <ComposerBox v-if="!showSettings" ref="composerBox" :input-value="input" :primary-disabled="primaryDisabled"
        :primary-is-stop="primaryIsStop" @update:input-value="input = $event" @input="handleInput"
        @enter="sendOnEnter" @submit="handlePrimaryAction" />
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
      <BrowserPanel ref="browserPanel" :active="!traceCollapsed" />
    </aside>
  </main>
</template>

