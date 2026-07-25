<script setup lang="ts">
import { ArrowDown, SkipForward, Trash2, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import WorkspaceLayout from '../../../components/layout/WorkspaceLayout.vue'
import { BrowserPanel, useBrowserWorkspace } from '../../browser'
import { useWorkspacePanels } from '../../../composables/useWorkspacePanels'
import { uiText } from '../../../text/uiText'
import ApprovalInlineBar from './ApprovalInlineBar.vue'
import AskInlineBar from './AskInlineBar.vue'
import ChatHeader from './ChatHeader.vue'
import ChatSidebar from './ChatSidebar.vue'
import ComposerBox from './ComposerBox.vue'
import ConversationView from './ConversationView.vue'
import { useAgentSession } from '../composables/useAgentSession'
import { useChatComposer } from '../composables/useChatComposer'
import { useComposerReasoning } from '../composables/useComposerReasoning'
import { useSessionNavigation } from '../composables/useSessionNavigation'
import type { Message, SessionSummary } from '../model/conversation'
import { formatSessionTime, formatTimelineTime } from '../presentation/timeFormat'
import type { TaskTemplate } from '../presentation/types'
import { isVisibleMessage, useConversationDisplay } from '../presentation/useConversationDisplay'

const props = defineProps<{
  active: boolean
}>()

const emit = defineEmits<{
  openSettings: []
}>()

const browserPanel = ref<InstanceType<typeof BrowserPanel> | null>(null)
const composerBox = ref<InstanceType<typeof ComposerBox> | null>(null)
const conversationView = ref<InstanceType<typeof ConversationView> | null>(null)
const copiedKey = ref('')
const showJumpToBottom = ref(false)
const processCollapsed = ref<Record<string, boolean>>({})
const runtimeNow = ref(Date.now())
let runtimeTimer: number | undefined
const {
  closeSidebar,
  closeTransientPanels,
  desktopLayout,
  handleGlobalKeydown,
  handleWindowResize,
  initWorkspacePanels,
  openWorkspace,
  sidebarCollapsed,
  sidebarOpen,
  toggleSidebar,
  toggleWorkspace,
  traceCollapsed,
} = useWorkspacePanels()
const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === 'tauri.localhost' ? 'http://127.0.0.1:4010' : '')
let sendNextQueuedMessage: () => Promise<void> = async () => undefined
const {
  cancelRun,
  archiveSession,
  checkServer,
  createSession,
  decideApproval,
  disposeAgentSession,
  events,
  forkSession,
  isRunning,
  isSubmittingApproval,
  isSubmittingAsk,
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
  forkMessage,
  initialSessionFromHash,
  selectSession,
  startNewSession,
} = useSessionNavigation({
  archiveSession,
  clearQueuedMessages,
  closeTransientPanels,
  createSession,
  forkSession,
  selectAgentSession,
  sessionId,
  sortedSessions,
})

function handleChatKeydown(event: KeyboardEvent) {
  if (props.active) handleGlobalKeydown(event)
}

function openSettings() {
  closeTransientPanels()
  emit('openSettings')
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

onMounted(async () => {
  window.addEventListener('keydown', handleChatKeydown)
  window.addEventListener('resize', handleWindowResize)
  loadComposerReasoningEffort()
  initBrowserWorkspace()
  initWorkspacePanels()

  if (await checkServer()) {
    await loadReasoningCapability()
    await loadSessions()
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
  window.removeEventListener('keydown', handleChatKeydown)
  window.removeEventListener('resize', handleWindowResize)
  disposeBrowserWorkspace()
  disposeAgentSession()
})

defineExpose({
  openBrowser: openLinkInBrowser,
  refreshSettings: loadReasoningCapability,
})
</script>

<template>
  <WorkspaceLayout
    :auxiliary-visible="!traceCollapsed"
    :sidebar-collapsed="sidebarCollapsed"
    :sidebar-open="sidebarOpen"
    :sidebar-preview="desktopLayout && sidebarCollapsed"
    auxiliary-label="Resize workspace"
    close-sidebar-label="Close chat list"
    sidebar-label="Resize chat list"
    @close-sidebar="closeSidebar"
  >
    <template #sidebar>
      <ChatSidebar :sessions="sortedSessions" :active-session-id="sessionId"
        :disabled="serverStatus !== 'online'" :running-session-ids="runningSessionIds" :settings-active="false" :session-label="sessionLabel"
        :session-meta="sessionMeta"
        @select-session="selectSession" @rename-session="renameSession" @archive-session="archiveSelectedSession"
        @pin-session="pinSession" @open-settings="openSettings" />
    </template>

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

      <ConversationView
        ref="conversationView"
        :api-base="apiBase"
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
      <div class="composer-zone">
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

    <template #auxiliary>
      <BrowserPanel ref="browserPanel" :active="active && !traceCollapsed" />
    </template>
  </WorkspaceLayout>
</template>

