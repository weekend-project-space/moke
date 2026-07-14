<script setup lang="ts">
import { ArrowDown, SkipForward, Trash2, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import ChatHeader from './components/ChatHeader.vue'
import SettingsPage from './components/SettingsPage.vue'
import SidebarPanel from './components/SidebarPanel.vue'
import { BrowserPanel, useBrowserWorkspace } from './features/browser'
import {
  ApprovalInlineBar,
  AskInlineBar,
  ComposerBox,
  ConversationView,
  formatSessionTime,
  formatTimelineTime,
  isVisibleMessage,
  useAgentSession,
  useChatComposer,
  useComposerReasoning,
  useConversationDisplay,
  useSessionNavigation,
  type Message,
  type SessionSummary,
  type TaskTemplate,
} from './features/chat'
import { useResizablePanels } from './composables/useResizablePanels'
import { uiText } from './text/uiText'

const browserPanel = ref<InstanceType<typeof BrowserPanel> | null>(null)
const composerBox = ref<InstanceType<typeof ComposerBox> | null>(null)
const conversationView = ref<InstanceType<typeof ConversationView> | null>(null)
const copiedKey = ref('')
const showJumpToBottom = ref(false)
const appView = ref<'chat' | 'settings'>('chat')
const settingsDirty = ref(false)
const showSettings = computed(() => appView.value === 'settings')
const processCollapsed = ref<Record<string, boolean>>({})
const runtimeNow = ref(Date.now())
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
let sendNextQueuedMessage: () => Promise<void> = async () => undefined
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
  isSubmittingApproval,
  isSubmittingAsk,
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
  onMessagesLoaded: async () => {
    resizeComposer()
  },
  onRunFinished: async () => {
    await sendNextQueuedMessage()
  },
})
const {
  activeModel,
  composerReasoningEffort,
  composerReasoningOptions,
  currentRunOptions,
  loadCapability: loadReasoningCapability,
  loadStoredSelection: loadComposerReasoningEffort,
} = useComposerReasoning({ apiBase, serverStatus })
const {
  addAttachments,
  applySuggestion,
  attachments,
  cancelQueuedMessage,
  cancelQueuedMessageAt,
  clearQueuedMessages,
  handleInput,
  handlePrimaryAction,
  input,
  primaryDisabled,
  primaryIsStop,
  queuedMessageCount,
  queuedMessageItems,
  queuedMessageLabel,
  queuedStopRequested,
  removeAttachment,
  sendOnEnter,
  sendQueuedMessageIfReady,
  stopAndSendQueuedMessage,
} = useChatComposer({
  cancelRun,
  currentRunOptions,
  isRunning,
  onFocus: () => composerBox.value?.focus(),
  onResize: resizeComposer,
  pendingAsk,
  runId,
  sendMessage,
  serverStatus,
  sessionId,
})
sendNextQueuedMessage = sendQueuedMessageIfReady
const {
  disposeBrowserWorkspace,
  initBrowserWorkspace,
  openLinkInBrowser,
} = useBrowserWorkspace({
  apiBase,
  getBrowserBounds: () => browserPanel.value?.getBounds() || null,
  openUrl: async (url, mode) => {
    await nextTick()
    if (!browserPanel.value) throw new Error('Browser panel is not mounted')
    await browserPanel.value.openUrl(url, mode)
  },
  openWorkspace,
})
const {
  archiveSelectedSession,
  closeSettings,
  forkMessage,
  initialSessionFromHash,
  openSettings,
  selectSession,
  startNewSession,
} = useSessionNavigation({
  appView,
  archiveSession,
  canLeaveSettings: () => !settingsDirty.value || window.confirm(uiText.skills.discardChanges),
  clearQueuedMessages,
  closeTransientPanels,
  createSession,
  forkSession,
  onCloseSettings: () => void loadReasoningCapability(),
  selectAgentSession,
  sessionId,
  sortedSessions,
})

function handleAppKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && showSettings.value) {
    event.preventDefault()
    closeSettings()
    return
  }

  handleGlobalKeydown(event)
}
const taskTemplates: TaskTemplate[] = uiText.chat.starters.map((prompt) => ({
  title: prompt,
  description: '',
  prompt,
}))
const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentTitle = computed(() => currentSession.value ? sessionLabel(currentSession.value) : uiText.app.newChat)
const sessionSubtitle = computed(() => {
  if (pendingAsk.value || pendingApproval.value) return ''
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
  runError,
  pendingAsk,
  pendingApproval,
  processCollapsed,
  toolLabels,
  formatTimelineTime,
})
const timelineNote = computed(() => {
  if (serverStatus.value === 'checking') return uiText.app.connectingToMoke
  if (serverStatus.value === 'offline') return uiText.app.disconnectedFromMoke
  if (runError.value) return runError.value
  if (isRunning.value) return ''
  return ''
})
const showThinking = computed(() => {
  const latestMessage = messages.value.at(-1)
  return isRunning.value
    && events.value.length === 0
    && !streamingText.value
    && !pendingAsk.value
    && !pendingApproval.value
    && latestMessage?.role === 'user'
})
const showEmptyState = computed(
  () => serverStatus.value === 'online' && visibleMessages.value.length === 0 && !isRunning.value,
)

function isFinalAssistantMessage(message: Message | undefined) {
  return message?.role === 'assistant' && isVisibleMessage(message)
}

function sessionLabel(session: SessionSummary) {
  return session.title || session.preview || uiText.app.newChat
}

function sessionMeta(session: SessionSummary) {
  return formatSessionTime(session.updated_at)
}

function resizeComposer() {
  composerBox.value?.resize()
}

function jumpToConversationBottom() {
  conversationView.value?.jumpToBottom()
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

watch(isRunning, (running) => {
  window.clearInterval(runtimeTimer)
  runtimeTimer = undefined
  runtimeNow.value = Date.now()

  if (!running) return

  runtimeTimer = window.setInterval(() => {
    runtimeNow.value = Date.now()
  }, 1000)
})

watch(showSettings, async (visible) => {
  if (!visible) return
  await nextTick()
  document.querySelector<HTMLButtonElement>('.settings-page .settings-navigation nav button')?.focus()
})

async function openLinkFromSettings(request: { url: string; mode: 'current' | 'new-tab' }) {
  if (!closeSettings()) return
  await nextTick()
  await openLinkInBrowser(request.url, request.mode)
}

onMounted(async () => {
  window.addEventListener('keydown', handleAppKeydown)
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
  window.removeEventListener('keydown', handleAppKeydown)
  window.removeEventListener('resize', handleWindowResize)
  disposeBrowserWorkspace()
  disposeResizablePanels()
  closeEventSource()
})
</script>

<template>
  <main
    class="shell"
    :class="{ 'trace-collapsed': traceCollapsed, 'settings-view': showSettings, 'sidebar-open': sidebarOpen, 'sidebar-collapsed': sidebarCollapsed, 'sidebar-resizing': sidebarResizing, 'workspace-resizing': workspaceResizing }"
    :style="shellStyle"
  >
    <button v-if="sidebarOpen" class="sidebar-scrim" type="button" aria-label="Close chat list"
      @click="closeSidebar"></button>
    <div class="sidebar-host" :class="{ 'sidebar-preview': desktopLayout && sidebarCollapsed }">
      <SidebarPanel :sessions="sortedSessions" :active-session-id="sessionId"
        :disabled="serverStatus !== 'online'" :running-session-ids="runningSessionIds" :settings-active="showSettings" :session-label="sessionLabel"
        :session-meta="sessionMeta"
        @select-session="selectSession" @rename-session="renameSession" @archive-session="archiveSelectedSession"
        @pin-session="pinSession" @open-settings="openSettings" />
    </div>
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
        v-if="!showSettings"
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
        @dirty-change="settingsDirty = $event"
        @open-browser-url="openLinkFromSettings"
      />
      <ConversationView
        v-else
        ref="conversationView"
        :copied-key="copiedKey"
        :display-items="displayItems"
        :session-key="sessionId"
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
            <ArrowDown :size="16" stroke-width="2.2" />
          </button>
          <ApprovalInlineBar
            v-if="pendingApproval"
            :approval="pendingApproval"
            :submitting="isSubmittingApproval"
            @approve="decideApproval($event.decision, $event.scope)"
          />
          <AskInlineBar
            v-if="pendingAsk"
            :ask="pendingAsk"
            :submitting="isSubmittingAsk"
            @select="selectAskOption"
          />
          <div
            v-if="queuedMessageCount"
            class="queued-message-panel"
            :class="{ compact: queuedMessageCount === 1 }"
          >
            <div v-if="queuedMessageCount > 1" class="queued-message-bar">
              <span>{{ queuedMessageLabel }}</span>
              <button type="button" :aria-label="uiText.composer.clearQueued" :title="uiText.composer.clearQueued" @click="cancelQueuedMessage">
                <Trash2 :size="14" stroke-width="2" />
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
                <span class="queued-message-order" :class="{ next: index === 0 }">
                  {{ queuedMessageCount === 1 ? uiText.composer.next : index + 1 }}
                </span>
                <span class="queued-message-copy">
                  <span class="queued-message-text">{{ item.preview }}</span>
                  <small v-if="queuedStopRequested">{{ queuedMessageLabel }}</small>
                  <small v-else-if="item.attachmentCount">{{ uiText.composer.queuedAttachments(item.attachmentCount) }}</small>
                  <small v-else-if="index === 0 && queuedMessageCount > 1">{{ uiText.composer.next }}</small>
                </span>
                <button
                  type="button"
                  :aria-label="uiText.composer.removeQueued(index + 1)"
                  :title="uiText.composer.removeQueuedTitle(index + 1)"
                  @click="cancelQueuedMessageAt(index)"
                >
                  <X :size="13" stroke-width="2.2" />
                </button>
                <button
                  v-if="queuedMessageCount === 1 && isRunning && !pendingAsk && !queuedStopRequested"
                  type="button"
                  class="primary"
                  :aria-label="uiText.composer.stopAndSendNext"
                  :title="uiText.composer.stopAndSendNext"
                  @click="stopAndSendQueuedMessage"
                >
                  <SkipForward :size="14" stroke-width="2.2" />
                </button>
              </div>
            </div>
          </div>
        </div>
        <ComposerBox ref="composerBox" :input-value="input" :primary-disabled="primaryDisabled"
          :primary-is-stop="primaryIsStop" :attachments="attachments"
          :model-name="activeModel?.model || ''" :model-provider="activeModel?.providerName || ''"
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
      v-if="!showSettings && !traceCollapsed"
      class="workspace-resizer"
      role="separator"
      aria-label="Resize workspace"
      aria-orientation="vertical"
      tabindex="0"
      @keydown="handleWorkspaceResizeKeydown"
      @pointerdown="startWorkspaceResize"
    ></div>

    <aside v-if="!showSettings && !traceCollapsed" class="workspace">
      <BrowserPanel ref="browserPanel" :active="!traceCollapsed" />
    </aside>
  </main>
</template>

