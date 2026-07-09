<script setup lang="ts">
import { ArrowDown, Clock3, SkipForward, X } from 'lucide-vue-next'
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
import { uiText } from './text/uiText'
import type { ImageAttachment, Message, ReasoningEffort, SessionSummary, TaskTemplate } from './types/conversation'

const input = ref('')
const attachments = ref<ImageAttachment[]>([])
const MAX_QUEUED_MESSAGES = 3
type DraftMessage = {
  content: string
  attachments: ImageAttachment[]
  options?: {
    reasoningEffort?: ReasoningEffort
  }
}
type ComposerReasoningEffort = 'default' | ReasoningEffort
type ReasoningCapability = {
  efforts: ReasoningEffort[]
  rawSupported: boolean
  supported: boolean
}
const queuedMessages = ref<DraftMessage[]>([])
const queuedSessionId = ref('')
const queuedStopRequested = ref(false)
const browserPanel = ref<InstanceType<typeof BrowserPanel> | null>(null)
const composerBox = ref<InstanceType<typeof ComposerBox> | null>(null)
const conversationView = ref<InstanceType<typeof ConversationView> | null>(null)
const copiedKey = ref('')
const showJumpToBottom = ref(false)
const showSettings = ref(false)
const processCollapsed = ref<Record<string, boolean>>({})
const runtimeNow = ref(Date.now())
const composerReasoningEffort = ref<ComposerReasoningEffort>('default')
const reasoningCapability = ref<ReasoningCapability>({
  efforts: [],
  rawSupported: false,
  supported: false,
})
let runtimeTimer: number | undefined
const {
  closeSidebar,
  closeTransientPanels,
  desktopLayout,
  disposeResizablePanels,
  handleGlobalKeydown,
  handleSidebarResizeKeydown,
  handleWindowResize,
  handleWorkspaceResizeKeydown,
  initResizablePanels,
  openWorkspace,
  shellStyle,
  sidebarCollapsed,
  sidebarOpen,
  sidebarResizing,
  startSidebarResize,
  startWorkspaceResize,
  toggleSidebar,
  toggleWorkspace,
  traceCollapsed,
  workspaceResizing,
} = useResizablePanels()
const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === 'tauri.localhost' ? 'http://127.0.0.1:4010' : '')
const COMPOSER_REASONING_KEY = 'moke.composer.reasoning-effort.v1'
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
  onRunFinished: async () => {
    await sendQueuedMessageIfReady()
  },
})
const {
  disposeBrowserWorkspace,
  initBrowserWorkspace,
  openLinkInBrowser,
} = useBrowserWorkspace({
  apiBase,
  getBrowserBounds: () => browserPanel.value?.getBounds() || null,
  openUrl: async (url) => {
    await nextTick()
    if (!browserPanel.value) throw new Error('Browser panel is not mounted')
    await browserPanel.value.openUrl(url)
  },
  openWorkspace,
})
const taskTemplates: TaskTemplate[] = uiText.chat.starters.map((prompt) => ({
  title: prompt,
  description: '',
  prompt,
}))
const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentTitle = computed(() => {
  if (showSettings.value) return uiText.app.settings
  return currentSession.value ? sessionLabel(currentSession.value) : uiText.app.newChat
})
const sessionSubtitle = computed(() => {
  if (showSettings.value) return uiText.app.settingsSubtitle
  if (pendingAsk.value) return uiText.app.waitingForResponse
  if (pendingApproval.value) return uiText.app.waitingForApproval
  if (isRunning.value) return uiText.app.working
  return ''
})
const serverStatusLabel = computed(() => {
  const labels = {
    checking: uiText.app.connecting,
    online: uiText.app.connected,
    offline: uiText.app.disconnected,
  }

  return labels[serverStatus.value]
})
const toolLabels: Record<string, string> = {
  apply_patch: uiText.toolLabel.applyPatch,
  bash: uiText.toolLabel.bash,
  cat: uiText.toolLabel.cat,
  exec_command: uiText.toolLabel.execCommand,
  find: uiText.toolLabel.find,
  grep: uiText.toolLabel.grep,
  ls: uiText.toolLabel.ls,
  npm: uiText.toolLabel.npm,
  rg: uiText.toolLabel.rg,
  sed: uiText.toolLabel.sed,
  view_image: uiText.toolLabel.viewImage,
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
const conversationScrollKey = computed(() => `${messages.value.length}:${events.value.length}:${streamingText.value.length}`)
const timelineNote = computed(() => {
  if (serverStatus.value === 'checking') return uiText.app.connectingToMoke
  if (serverStatus.value === 'offline') return uiText.app.disconnectedFromMoke
  if (runError.value) return runError.value
  if (pendingAsk.value) return uiText.app.waitingForResponseNote
  if (pendingApproval.value) return uiText.app.approvalRequiredNote
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
  if (isRunning.value) {
    if (pendingAsk.value) return true
    if (hasDraftContent.value) return queuedMessages.value.length >= MAX_QUEUED_MESSAGES
    return !runId.value
  }
  return serverStatus.value !== 'online' || !hasDraftContent.value
})
const primaryIsStop = computed(() => isRunning.value && !pendingAsk.value && !hasDraftContent.value)
const hasDraftContent = computed(() => Boolean(input.value.trim()) || attachments.value.length > 0)
const queuedMessageCount = computed(() => queuedMessages.value.length)
const queuedMessageLabel = computed(() => queuedStopRequested.value ? uiText.composer.sendAfterStopping : uiText.composer.queued(queuedMessageCount.value))
const queuedMessagePreview = computed(() => queuedMessages.value.map((message, index) => `${index + 1}. ${draftPreview(message)}`).join('\n'))
const queuedMessageItems = computed(() => queuedMessages.value.map((message) => ({
  content: draftPreview(message),
  preview: draftPreview(message),
})))
const composerReasoningOptions = computed(() => reasoningCapability.value.supported ? reasoningCapability.value.efforts : [])

function isFinalAssistantMessage(message: Message | undefined) {
  return message?.role === 'assistant' && isVisibleMessage(message)
}

function sessionLabel(session: SessionSummary) {
  return session.title || session.preview || uiText.app.newChat
}

function sessionMeta(session: SessionSummary) {
  return formatSessionTime(session.updated_at)
}

function formatSessionTime(value: string) {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return 'Just now'

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
  if (targetDay === today - 24 * 60 * 60 * 1000) return `Yesterday ${timeLabel}`

  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(date)

  if (date.getFullYear() === now.getFullYear()) return `${dateLabel} ${timeLabel}`

  return `${date.getFullYear()} ${dateLabel} ${timeLabel}`
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

async function loadReasoningCapability() {
  if (serverStatus.value !== 'online') return

  try {
    const response = await fetch(`${apiBase}/api/settings`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    const capability = data.reasoningCapability || {}
    const efforts = Array.isArray(capability.efforts)
      ? capability.efforts.filter(isReasoningEffort)
      : []
    reasoningCapability.value = {
      efforts,
      rawSupported: capability.rawSupported === true,
      supported: capability.supported === true && efforts.length > 0,
    }
    normalizeComposerReasoningEffort()
  } catch {
    reasoningCapability.value = {
      efforts: [],
      rawSupported: false,
      supported: false,
    }
    composerReasoningEffort.value = 'default'
  }
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'ultra'
}

function isComposerReasoningEffort(value: unknown): value is ComposerReasoningEffort {
  return value === 'default' || isReasoningEffort(value)
}

function loadComposerReasoningEffort() {
  try {
    const stored = window.localStorage.getItem(COMPOSER_REASONING_KEY)
    if (isComposerReasoningEffort(stored)) composerReasoningEffort.value = stored
  } catch {
    composerReasoningEffort.value = 'default'
  }
}

function persistComposerReasoningEffort(value: ComposerReasoningEffort) {
  try {
    window.localStorage.setItem(COMPOSER_REASONING_KEY, value)
  } catch {
    // Keep the current in-memory selection when localStorage is unavailable.
  }
}

function normalizeComposerReasoningEffort() {
  if (composerReasoningEffort.value === 'default') return
  if (
    !reasoningCapability.value.supported ||
    !reasoningCapability.value.efforts.includes(composerReasoningEffort.value)
  ) {
    composerReasoningEffort.value = 'default'
  }
}

function currentRunOptions() {
  return composerReasoningEffort.value === 'default'
    ? undefined
    : { reasoningEffort: composerReasoningEffort.value }
}

async function selectSession(id: string) {
  conversationView.value?.resetAutoScroll()
  if (await selectAgentSession(id)) {
    clearQueuedMessage()
    showSettings.value = false
    writeSessionIdToHash(id)
    closeTransientPanels()
  }
}

async function startNewSession() {
  if (await createSession()) {
    clearQueuedMessage()
    showSettings.value = false
    writeSessionIdToHash(sessionId.value)
    closeTransientPanels()
  }
}

async function forkMessage(messageId: string) {
  conversationView.value?.resetAutoScroll()
  if (await forkSession(messageId)) {
    clearQueuedMessage()
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
  void loadReasoningCapability()
}

function sendOnEnter(event: KeyboardEvent) {
  if (event.shiftKey) return
  if (isRunning.value && !input.value.trim()) return
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
    if (hasDraftContent.value) {
      queueCurrentInput()
      return
    }

    if (!pendingAsk.value) void cancelRun()
    return
  }

  void submitMessage()
}

async function submitMessage() {
  const content = input.value.trim()
  if ((!content && !attachments.value.length) || isRunning.value) return

  await sendContent({ content, attachments: [...attachments.value], options: currentRunOptions() }, true)
}

async function sendContent(draft: DraftMessage, restoreOnFail: boolean) {
  const previousInput = input.value
  const previousAttachments = [...attachments.value]
  input.value = ''
  attachments.value = []
  await nextTick()
  resizeComposer()

  if (await sendMessage(draft)) return

  if (restoreOnFail) {
    input.value = previousInput || draft.content
    attachments.value = previousAttachments.length ? previousAttachments : draft.attachments
  }
  await nextTick()
  resizeComposer()
}

function queueCurrentInput() {
  const content = input.value.trim()
  if ((!content && !attachments.value.length) || !sessionId.value) return
  if (queuedMessages.value.length >= MAX_QUEUED_MESSAGES) return

  queuedMessages.value = [...queuedMessages.value, { content, attachments: [...attachments.value], options: currentRunOptions() }]
  queuedSessionId.value = sessionId.value
  queuedStopRequested.value = false
  input.value = ''
  attachments.value = []
  void nextTick(() => {
    resizeComposer()
    composerBox.value?.focus()
  })
}

function clearQueuedMessage() {
  queuedMessages.value = []
  queuedSessionId.value = ''
  queuedStopRequested.value = false
}

function cancelQueuedMessage() {
  clearQueuedMessage()
}

function cancelQueuedMessageAt(index: number) {
  queuedMessages.value = queuedMessages.value.filter((_, itemIndex) => itemIndex !== index)
  if (!queuedMessages.value.length) clearQueuedMessage()
}

function stopAndSendQueuedMessage() {
  if (!queuedMessages.value.length || !isRunning.value || pendingAsk.value) return
  queuedStopRequested.value = true
  void cancelRun()
}

async function sendQueuedMessageIfReady() {
  if (!queuedMessages.value.length || isRunning.value) return
  if (queuedSessionId.value && queuedSessionId.value !== sessionId.value) return

  const [content, ...rest] = queuedMessages.value
  queuedMessages.value = rest
  if (!rest.length) {
    queuedSessionId.value = ''
    queuedStopRequested.value = false
  }
  await sendContent(content, true)
}

function draftPreview(message: DraftMessage) {
  const imageLabel = message.attachments.length ? ` - ${message.attachments.length} image${message.attachments.length > 1 ? 's' : ''}` : ''
  const text = message.content || 'Image'
  const preview = text.length > 48 ? `${text.slice(0, 48)}...` : text
  return `${preview}${imageLabel}`
}

function addAttachments(nextAttachments: ImageAttachment[]) {
  const merged = [...attachments.value, ...nextAttachments]
  attachments.value = merged.slice(0, 4)
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((attachment) => attachment.id !== id)
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

watch(composerReasoningEffort, (value) => {
  persistComposerReasoningEffort(value)
})

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('resize', handleWindowResize)
  loadComposerReasoningEffort()
  initBrowserWorkspace()
  initResizablePanels()

  if (await checkServer()) {
    await loadReasoningCapability()
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
    <button v-if="sidebarOpen" class="sidebar-scrim" type="button" aria-label="Close chat list"
      @click="closeSidebar"></button>
    <SidebarPanel :sessions="sortedSessions" :active-session-id="sessionId"
      :disabled="serverStatus !== 'online'" :running-session-ids="runningSessionIds" :settings-active="showSettings" :session-label="sessionLabel"
      :session-meta="sessionMeta"
      @select-session="selectSession" @rename-session="renameSession" @archive-session="archiveSelectedSession"
      @pin-session="pinSession" @open-settings="openSettings" />
    <div
      class="sidebar-resizer"
      role="separator"
      aria-label="Resize chat list"
      aria-orientation="vertical"
      tabindex="0"
      @keydown="handleSidebarResizeKeydown"
      @pointerdown="startSidebarResize"
    ></div>

    <section class="chat">
      <ChatHeader
        :title="currentTitle"
        :subtitle="sessionSubtitle"
        :desktop-layout="desktopLayout"
        :sidebar-collapsed="sidebarCollapsed"
        :trace-collapsed="traceCollapsed"
        :server-status="serverStatus"
        :server-status-label="serverStatusLabel"
        @new-session="startNewSession"
        @toggle-sidebar="toggleSidebar"
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
        :scroll-key="conversationScrollKey"
        :is-running="isRunning"
        :show-empty-state="showEmptyState"
        :show-last-message-continue="Boolean(lastAssistantMessage) && !isRunning && !pendingAsk && !pendingApproval"
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
      <div v-if="!showSettings" class="composer-zone">
        <div
          v-if="showJumpToBottom || pendingApproval || pendingAsk || queuedMessageCount"
          class="composer-overlay-stack"
        >
          <button
            v-if="showJumpToBottom"
            class="jump-inline"
            type="button"
            :aria-label="uiText.app.jumpToBottom"
            :title="uiText.app.jumpToBottom"
            @click="jumpToConversationBottom"
          >
            <ArrowDown :size="15" stroke-width="2.2" />
          </button>
          <ApprovalInlineBar
            v-if="pendingApproval"
            :approval="pendingApproval"
            @approve="decideApproval($event.decision, $event.scope)"
          />
          <AskInlineBar v-if="pendingAsk" :ask="pendingAsk" @select="selectAskOption" />
          <div
            v-if="queuedMessageCount"
            class="queued-message-panel"
            :title="queuedMessagePreview"
          >
            <div class="queued-message-bar">
              <Clock3 :size="14" stroke-width="2.2" />
              <span>{{ queuedMessageLabel }}</span>
              <button type="button" :aria-label="uiText.composer.clearQueued" :title="uiText.composer.clearQueued" @click="cancelQueuedMessage">
                <X :size="14" stroke-width="2.2" />
              </button>
              <button
                v-if="isRunning && !pendingAsk && !queuedStopRequested"
                type="button"
                class="primary"
                :aria-label="uiText.composer.stopAndSendNext"
                :title="uiText.composer.stopAndSendNext"
                @click="stopAndSendQueuedMessage"
              >
                <SkipForward :size="14" stroke-width="2.2" />
              </button>
            </div>
            <div class="queued-message-list" :aria-label="uiText.composer.queuedMessages">
              <div v-for="(item, index) in queuedMessageItems" :key="`${index}-${item.content}`" class="queued-message-item">
                <span class="queued-message-text">{{ item.preview }}</span>
                <button
                  type="button"
                  :aria-label="uiText.composer.removeQueued(index + 1)"
                  :title="uiText.composer.removeQueuedTitle(index + 1)"
                  @click="cancelQueuedMessageAt(index)"
                >
                  <X :size="13" stroke-width="2.2" />
                </button>
              </div>
            </div>
          </div>
        </div>
        <ComposerBox ref="composerBox" :input-value="input" :primary-disabled="primaryDisabled"
          :primary-is-stop="primaryIsStop" :attachments="attachments"
          :reasoning-effort="composerReasoningEffort"
          :reasoning-options="composerReasoningOptions"
          @update:input-value="input = $event"
          @update:reasoning-effort="composerReasoningEffort = $event"
          @input="handleInput"
          @add-attachments="addAttachments" @remove-attachment="removeAttachment"
          @enter="sendOnEnter" @submit="handlePrimaryAction" />
      </div>
    </section>

    <div
      v-if="!traceCollapsed"
      class="workspace-resizer"
      role="separator"
      aria-label="Resize workspace"
      aria-orientation="vertical"
      tabindex="0"
      @keydown="handleWorkspaceResizeKeydown"
      @pointerdown="startWorkspaceResize"
    ></div>

    <aside v-if="!traceCollapsed" class="workspace">
      <BrowserPanel ref="browserPanel" :active="!traceCollapsed" />
    </aside>
  </main>
</template>

