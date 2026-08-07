<script setup lang="ts">
import { ArrowDown, SkipForward, Trash2, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '../../../components/layout/WorkspaceLayout.vue'
import { BrowserPanel, useBrowserWorkspace } from '../../browser'
import { ScheduledTasksWorkspace } from '../../scheduled-tasks'
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
import { useRecentWorkspaces } from '../composables/useRecentWorkspaces'
import { useSessionNavigation } from '../composables/useSessionNavigation'
import type { ApprovalMode, Message, SessionSummary } from '../model/conversation'
import { isNativeWorkspacePickerAvailable, isSupportedImagePath, pickLocalFiles, pickWorkspaceDirectory, readLocalImage } from '../services/workspacePicker'
import { formatSessionTime, formatTimelineTime } from '../presentation/timeFormat'
import type { TaskTemplate } from '../presentation/types'
import { isVisibleMessage, useConversationDisplay } from '../presentation/useConversationDisplay'

defineOptions({ name: 'ChatWorkspace' })

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
const nativeWorkspacePicker = ref(isNativeWorkspacePickerAvailable())
const route = useRoute()
const router = useRouter()
const workspaceActive = computed(() => route.name === 'chat' || route.name === 'tasks')
const scheduledTasksActive = computed(() => route.name === 'tasks')
let runtimeTimer: number | undefined
let chatRouteReady = false
const {
  closeSidebar,
  closeWorkspace,
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
  toggleWorkspaceMaximized,
  traceCollapsed,
  workspaceMaximized,
} = useWorkspacePanels()
const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === 'tauri.localhost' ? 'http://127.0.0.1:4010' : '')
let sendNextQueuedMessage: () => Promise<void> = async () => undefined
const {
  cancelRun,
  archiveSession,
  checkServer,
  decideApproval,
  disposeAgentSession,
  events,
  forkSession,
  isRunning,
  isSubmittingApproval,
  isSubmittingAsk,
  loadSessions,
  messages,
  newSessionDraft,
  pendingApproval,
  pendingAsk,
  pinSession,
  renameSession,
  runError,
  runId,
  runningSessionIds,
  selectAskOption,
  setDraftWorkspace,
  setApprovalMode,
  selectSession: selectAgentSession,
  sendMessage,
  serverStatus,
  sessionId,
  sessions,
  sortedSessions,
  startNewSession: startAgentSession,
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
  onSessionCreated: (id) => {
    void router.replace({ name: 'chat', params: id ? { sessionId: id } : {} })
  },
})
const {
  activeModel,
  composerReasoningEffort,
  composerReasoningOptions,
  currentRunEnvironment,
  loadCapability: loadReasoningCapability,
  loadStoredSelection: loadComposerReasoningEffort,
} = useComposerReasoning({ apiBase, serverStatus })
const {
  recentWorkspaces,
  rememberWorkspace,
  seedRecentWorkspaces,
} = useRecentWorkspaces()
const {
  addAttachments,
  addFiles,
  applySuggestion,
  attachments,
  files,
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
  removeFile,
  sendOnEnter,
  sendQueuedMessageIfReady,
  stopAndSendQueuedMessage,
} = useChatComposer({
  cancelRun,
  currentRunEnvironment,
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
  closeWorkspace,
})
const {
  archiveSelectedSession,
  forkMessage,
  initialSession,
  selectSession: navigateToSession,
  startNewSession: createNewSession,
} = useSessionNavigation({
  archiveSession,
  clearQueuedMessages,
  closeTransientPanels,
  forkSession,
  selectAgentSession,
  sessionId,
  startAgentSession,
  sortedSessions,
  readSessionId: () => route.name === 'chat' && typeof route.params.sessionId === 'string' ? route.params.sessionId : '',
  writeSessionId: (id, replace = false) => {
    const location = { name: 'chat', params: id ? { sessionId: id } : {} }
    void (replace ? router.replace(location) : router.push(location))
  },
})

function handleChatKeydown(event: KeyboardEvent) {
  if (workspaceActive.value) handleGlobalKeydown(event)
}

function openSettings() {
  closeTransientPanels()
  emit('openSettings')
}

async function updateApprovalMode(mode: ApprovalMode) {
  if (mode === currentApprovalMode.value) return
  await setApprovalMode(mode)
}

function updateDraftWorkspace(root: string) {
  if (setDraftWorkspace(root)) rememberWorkspace(root)
}

async function chooseDraftWorkspaceDirectory() {
  try {
    const root = await pickWorkspaceDirectory(newSessionDraft.workspace?.root)
    if (root) updateDraftWorkspace(root)
  } catch {
    nativeWorkspacePicker.value = false
    await nextTick()
    composerBox.value?.openWorkspaceEditor()
  }
}

async function chooseFiles() {
  try {
    const selected = await pickLocalFiles(currentWorkspaceRoot.value)
    const imagePaths = selected.filter(isSupportedImagePath)
    const filePaths = selected.filter((path) => !isSupportedImagePath(path))
    addFiles(filePaths.map((path) => ({
      name: path.split(/[\\/]/).pop() || path,
      path,
    })))
    const images = await Promise.allSettled(imagePaths.map(readLocalImage))
    const localImages = images.flatMap((result) => result.status === 'fulfilled'
      ? [{ ...result.value, id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, kind: 'image' as const }]
      : [])
    composerBox.value?.addLocalImages(localImages, images.some((result) => result.status === 'rejected'))
  } catch (error) {
    console.error('Failed to choose files or images', error)
  }
}

const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentTitle = computed(() => currentSession.value ? sessionLabel(currentSession.value) : uiText.app.newChat)
const currentApprovalMode = computed(() => currentSession.value?.env?.approval_mode || newSessionDraft.approval_mode)
const currentWorkspaceRoot = computed(() => currentSession.value?.env?.workspace.root || newSessionDraft.workspace?.root || '')
const draftWorkspaceRoot = computed(() => sessionId.value ? undefined : newSessionDraft.workspace?.root || '')
const taskTemplates = computed<TaskTemplate[]>(() => (currentWorkspaceRoot.value ? uiText.chat.workspaceStarters : uiText.chat.webStarters).map((starter) => ({
  title: starter.title,
  description: '',
  prompt: starter.prompt,
})))
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
  const title = session.title || session.preview || uiText.app.newChat
  return title.startsWith('Scheduled: ') ? title.slice('Scheduled: '.length) : title
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

async function selectSession(id: string) {
  await navigateToSession(id)
}

async function startNewSession() {
  await createNewSession()
}

watch(() => route.name, (name) => {
  if (name === 'tasks') closeTransientPanels()
}, { immediate: true })

watch(() => [route.name, route.params.sessionId] as const, ([name, value]) => {
  if (!chatRouteReady || name !== 'chat') return
  if (typeof value === 'string' && value) {
    if (value === sessionId.value) return
    if (sortedSessions.value.some((session) => session.id === value)) {
      void navigateToSession(value)
    } else {
      void createNewSession(true)
    }
  } else if (sessionId.value) {
    void createNewSession()
  }
})

watch(sortedSessions, (nextSessions) => {
  seedRecentWorkspaces(nextSessions.flatMap((session) =>
    session.env?.workspace.root ? [session.env.workspace.root] : [],
  ))
}, { immediate: true })

onMounted(async () => {
  window.addEventListener('keydown', handleChatKeydown)
  window.addEventListener('resize', handleWindowResize)
  loadComposerReasoningEffort()
  await initBrowserWorkspace()
  initWorkspacePanels()

  if (await checkServer()) {
    await loadReasoningCapability()
    await loadSessions()
    if (scheduledTasksActive.value) {
      chatRouteReady = true
      return
    }
    const routedSession = initialSession()
    if (routedSession) {
      await selectSession(routedSession.id)
    } else {
      await createNewSession(Boolean(route.params.sessionId))
    }
  }
  chatRouteReady = true
})

onUnmounted(() => {
  window.clearInterval(runtimeTimer)
  window.removeEventListener('keydown', handleChatKeydown)
  window.removeEventListener('resize', handleWindowResize)
  disposeBrowserWorkspace()
  disposeAgentSession()
})

defineExpose({
  newSession: startNewSession,
  openBrowser: openLinkInBrowser,
  refreshSettings: loadReasoningCapability,
})
</script>

<template>
  <WorkspaceLayout
    :auxiliary-visible="!scheduledTasksActive && !traceCollapsed"
    :auxiliary-maximized="workspaceMaximized"
    :sidebar-collapsed="sidebarCollapsed"
    :sidebar-open="sidebarOpen"
    :sidebar-preview="desktopLayout && sidebarCollapsed"
    auxiliary-label="Resize workspace"
    close-sidebar-label="Close chat list"
    sidebar-label="Resize chat list"
    @close-sidebar="closeSidebar"
  >
    <template #sidebar>
      <ChatSidebar :sessions="sortedSessions" :active-session-id="scheduledTasksActive ? '' : sessionId"
        :disabled="serverStatus !== 'online'" :running-session-ids="runningSessionIds" :settings-active="false"
        :new-session-active="!scheduledTasksActive && !sessionId"
        :scheduled-tasks-active="scheduledTasksActive" :session-label="sessionLabel"
        :session-meta="sessionMeta"
        @select-session="selectSession" @rename-session="renameSession" @archive-session="archiveSelectedSession"
        @pin-session="pinSession" @new-session="startNewSession" @open-settings="openSettings" />
    </template>

    <section v-if="!scheduledTasksActive" class="chat">
      <ChatHeader
        :title="currentTitle"
        :subtitle="sessionSubtitle"
        :desktop-layout="desktopLayout"
        :sidebar-collapsed="sidebarCollapsed"
        :trace-collapsed="traceCollapsed"
        :server-status="serverStatus"
        :server-status-label="serverStatusLabel"
        :workspace-root="currentWorkspaceRoot"
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
          :primary-is-stop="primaryIsStop" :attachments="attachments" :files="files"
          :model-name="activeModel?.model || ''" :model-provider="activeModel?.providerName || ''"
          :reasoning-effort="composerReasoningEffort"
          :reasoning-options="composerReasoningOptions"
          :approval-mode="currentApprovalMode"
          :native-workspace-picker="nativeWorkspacePicker"
          :workspace-root="draftWorkspaceRoot"
          :workspace-suggestions="recentWorkspaces"
          @update:input-value="input = $event"
          @update:reasoning-effort="composerReasoningEffort = $event"
          @update:approval-mode="updateApprovalMode"
          @update:workspace-root="updateDraftWorkspace"
          @choose-workspace-directory="chooseDraftWorkspaceDirectory"
          @choose-files="chooseFiles"
          @input="handleInput"
          @add-attachments="addAttachments" @remove-attachment="removeAttachment" @remove-file="removeFile"
          @enter="sendOnEnter" @submit="handlePrimaryAction" />
      </div>
    </section>

    <ScheduledTasksWorkspace
      v-else
      :api-base="apiBase"
      :default-workspace="newSessionDraft.workspace?.root || ''"
      :workspace-options="recentWorkspaces"
      @open-session="selectSession"
      @toggle-sidebar="toggleSidebar"
    />

    <template #auxiliary>
      <BrowserPanel ref="browserPanel" :active="workspaceActive && !scheduledTasksActive && !traceCollapsed" :maximized="workspaceMaximized" @toggle-maximized="toggleWorkspaceMaximized" />
    </template>
  </WorkspaceLayout>
</template>

