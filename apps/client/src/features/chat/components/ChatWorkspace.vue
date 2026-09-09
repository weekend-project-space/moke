<script setup lang="ts">
import { ArrowDown, ChevronDown, Globe, Maximize2, Minimize2, PanelRight, Plus, SkipForward, SquareTerminal, Trash2, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '../../../components/layout/WorkspaceLayout.vue'
import { BrowserPanel, useBrowserWorkspace, type BrowserPage } from '../../browser'
import { ScheduledTasksWorkspace } from '../../scheduled-tasks'
import { TerminalPanel } from '../../terminal'
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
import type { ApprovalMode, Message, ReasoningEffort, SessionSummary } from '../model/conversation'
import { isNativeWorkspacePickerAvailable, isSupportedImagePath, pickLocalFiles, pickWorkspaceDirectory, readLocalImage } from '../services/workspacePicker'
import { formatSessionTime } from '../presentation/timeFormat'
import { isVisibleMessage, useConversationDisplay } from '../presentation/useConversationDisplay'
import { useWorkspaceDiscovery } from '../composables/useWorkspaceDiscovery'

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
const auxiliaryMode = ref<'browser' | 'terminal'>('browser')
const browserTabs = ref<BrowserPage[]>([])
const activeBrowserTabKey = ref<string | null>(null)
const terminalTabs = ref<Array<{ id: string; title: string; cwd: string }>>([])
const activeTerminalTabId = ref('')
const workspaceMenuOpen = ref(false)
const workspaceCloseMenu = ref<{ id: string; x: number; y: number } | null>(null)
const closeMenuElement = ref<HTMLElement | null>(null)
let closeMenuTrigger: HTMLElement | null = null
let closeMenuVersion = 0
let terminalTabSequence = 1
let browserTabSequence = 1
const browserTabOrder = new Map<number, number>()
const workspaceTabOrder = ref<string[]>([])
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
  toolCalls,
  answeredInteractions,
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
  setModel,
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
const currentSession = computed(() => sessions.value.find((session) => session.id === sessionId.value))
const currentWorkspaceRoot = computed(() => currentSession.value?.env?.workspace.root || newSessionDraft.workspace?.root || '')
const draftWorkspaceRoot = computed(() => sessionId.value ? undefined : newSessionDraft.workspace?.root || '')
const selectedModel = computed(() => sessionId.value ? currentSession.value?.env?.model : newSessionDraft.model)
const backendReasoningEffort = computed<ReasoningEffort | null | undefined>(() => {
  if (!sessionId.value || !currentSession.value) return undefined
  return currentSession.value.env?.reasoningEffort || null
})
const {
  activeModel,
  composerModelOptions,
  composerReasoningEffort,
  composerReasoningOptions,
  currentRunEnvironment,
  loadCapability: loadReasoningCapability,
  loadStoredSelection: loadComposerReasoningEffort,
  selectModel,
} = useComposerReasoning({ apiBase, backendReasoningEffort, serverStatus, selectedModel, setModel })
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
  workspaceEntries,
  workspaceSkills,
} = useWorkspaceDiscovery({
  apiBase,
  input,
  sessionId,
  currentWorkspaceRoot,
  getDraftWorkspaceRoot: () => newSessionDraft.workspace?.root,
})
const {
  disposeBrowserWorkspace,
  initBrowserWorkspace,
  openLinkInBrowser,
} = useBrowserWorkspace({
  apiBase,
  getBrowserBounds: () => browserPanel.value?.getBounds() || null,
  openUrl: async (url, mode) => {
    auxiliaryMode.value = 'browser'
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

function browserTabKey(tab: BrowserPage) {
  return `browser-${tab.pageId}`
}

function browserFavicon(tab: BrowserPage) {
  return tab.faviconUrl || tab.faviconUrls?.[0] || ''
}

function openBrowserTabMenu(event: MouseEvent, tab: BrowserPage) {
  void openTerminalCloseMenu(event, browserTabKey(tab))
}

function activeWorkspaceTabId() {
  if (auxiliaryMode.value === 'terminal') return activeTerminalTabId.value
  return activeBrowserTabKey.value || ''
}

function handleBrowserStateChange(state: { tabs: BrowserPage[]; activeTabKey: string | null }) {
  for (const tab of state.tabs) {
    if (!browserTabOrder.has(tab.pageId)) browserTabOrder.set(tab.pageId, browserTabSequence++)
    const key = browserTabKey(tab)
    if (!workspaceTabOrder.value.includes(key)) workspaceTabOrder.value.push(key)
  }
  browserTabs.value = [...state.tabs].sort((left, right) => {
    return (browserTabOrder.get(left.pageId) || Number.MAX_SAFE_INTEGER)
      - (browserTabOrder.get(right.pageId) || Number.MAX_SAFE_INTEGER)
  })
  activeBrowserTabKey.value = state.activeTabKey ? state.activeTabKey.replace(/^page-/, 'browser-') : null
  const live = new Set(state.tabs.map(browserTabKey))
  workspaceTabOrder.value = workspaceTabOrder.value.filter((key) => !key.startsWith('browser-') || live.has(key))
}

function selectBrowserWorkspaceTab(tab: BrowserPage) {
  workspaceMenuOpen.value = false
  auxiliaryMode.value = 'browser'
  openWorkspace()
  void browserPanel.value?.selectTab(tab)
}

function selectTerminalWorkspaceTab(id: string) {
  workspaceMenuOpen.value = false
  if (!terminalTabs.value.some((tab) => tab.id === id)) return
  activeTerminalTabId.value = id
  auxiliaryMode.value = 'terminal'
  openWorkspace()
}

function createWorkspaceTab(type: 'browser' | 'terminal') {
  workspaceMenuOpen.value = false
  if (type === 'browser') {
    auxiliaryMode.value = 'browser'
    openWorkspace()
    void browserPanel.value?.createTab()
    return
  }
  if (!currentWorkspaceRoot.value) return
  const id = `terminal-${terminalTabSequence++}`
  terminalTabs.value.push({ id, title: `Terminal ${terminalTabs.value.length + 1}`, cwd: currentWorkspaceRoot.value })
  workspaceTabOrder.value.push(id)
  activeTerminalTabId.value = id
  auxiliaryMode.value = 'terminal'
  openWorkspace()
}

function closeTerminalWorkspaceTab(id: string) {
  const index = terminalTabs.value.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const orderIndex = workspaceTabOrder.value.indexOf(id)
  const nextKey = orderIndex >= 0
    ? workspaceTabOrder.value.slice(orderIndex + 1).find((key) => key !== id)
      || workspaceTabOrder.value.slice(0, orderIndex).reverse().find((key) => key !== id)
    : undefined
  terminalTabs.value.splice(index, 1)
  workspaceTabOrder.value = workspaceTabOrder.value.filter((key) => key !== id)
  if (activeTerminalTabId.value !== id) return
  const browser = browserTabs.value.find((tab) => browserTabKey(tab) === nextKey)
  if (browser) {
    auxiliaryMode.value = 'browser'
    void nextTick(() => browserPanel.value?.selectTab(browser))
    return
  }
  if (nextKey?.startsWith('terminal-')) {
    activeTerminalTabId.value = nextKey
    auxiliaryMode.value = 'terminal'
    return
  }
  activeTerminalTabId.value = ''
  auxiliaryMode.value = 'browser'
}

function toggleWorkspaceMenu(event: MouseEvent | KeyboardEvent) {
  if (event.currentTarget instanceof HTMLElement) void browserPanel.value?.openWorkspaceMenu(event.currentTarget)
}

async function openTerminalCloseMenu(event: MouseEvent, id: string) {
  event.preventDefault()
  event.stopPropagation()
  const version = ++closeMenuVersion
  const trigger = event.currentTarget as HTMLElement
  const x = event.clientX
  const y = event.clientY
  if (!await browserPanel.value?.prepareWorkspaceContextMenu()) return
  if (version !== closeMenuVersion || !workspaceTabOrder.value.includes(id)) {
    await browserPanel.value?.resumeViewport()
    return
  }
  closeMenuTrigger = trigger
  workspaceCloseMenu.value = { id, x, y }
  await nextTick()
  const rect = closeMenuElement.value?.getBoundingClientRect()
  if (!workspaceCloseMenu.value || !rect) return
  workspaceCloseMenu.value.x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
  workspaceCloseMenu.value.y = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
  closeMenuItems()[0]?.focus()
}

async function closeWorkspaceMenu(restoreFocus = false, resume = true) {
  closeMenuVersion++
  workspaceCloseMenu.value = null
  if (restoreFocus) closeMenuTrigger?.focus()
  if (resume) await browserPanel.value?.resumeViewport()
}
function closeMenuItems() {
  return Array.from(closeMenuElement.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])
}
function handleCloseMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    event.stopPropagation()
    void closeWorkspaceMenu(true)
    return
  }
  const items = closeMenuItems()
  if (!items.length) return
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current + items.length - 1) % items.length : -1
  if (index < 0) return
  event.preventDefault()
  items[index]?.focus()
}
async function closeWorkspaceTabsFromMenu(scope: 'tab' | 'others' | 'right') {
  const index = workspaceTabOrder.value.indexOf(workspaceCloseMenu.value?.id || '')
  if (index < 0) return closeWorkspaceMenu()
  const ids = scope === 'tab' ? [workspaceTabOrder.value[index]] : scope === 'others' ? workspaceTabOrder.value.filter((_, i) => i !== index) : workspaceTabOrder.value.slice(index + 1)
  const active = activeWorkspaceTabId()
  const activeIndex = workspaceTabOrder.value.indexOf(active)
  const next = ids.includes(active)
    ? workspaceTabOrder.value.slice(activeIndex + 1).find((id) => !ids.includes(id)) || workspaceTabOrder.value.slice(0, activeIndex).reverse().find((id) => !ids.includes(id))
    : active
  await closeWorkspaceMenu(false, false)
  try {
    for (const id of ids) {
      const tab = browserTabs.value.find((candidate) => browserTabKey(candidate) === id)
      if (tab) await browserPanel.value?.closeTabs(tab, 'tab')
      else closeTerminalWorkspaceTab(id)
    }
    const browser = browserTabs.value.find((tab) => browserTabKey(tab) === next)
    if (browser) {
      auxiliaryMode.value = 'browser'
      await nextTick()
      await browserPanel.value?.selectTab(browser)
    } else if (next) selectTerminalWorkspaceTab(next)
  } finally {
    await nextTick()
    await browserPanel.value?.resumeViewport()
  }
}

function dismissCloseMenu() { void closeWorkspaceMenu() }
watch(workspaceTabOrder, () => { if (workspaceCloseMenu.value) dismissCloseMenu() }, { deep: true })

watch([workspaceActive, scheduledTasksActive, traceCollapsed, workspaceMaximized, auxiliaryMode], () => {
  if (workspaceCloseMenu.value) dismissCloseMenu()
  void browserPanel.value?.closeWorkspaceMenu()
})

async function updateApprovalMode(mode: ApprovalMode) {
  if (mode === currentApprovalMode.value) return
  await setApprovalMode(mode)
}

function updateDraftWorkspace(root: string) {
  if (setDraftWorkspace(root)) {
    rememberWorkspace(root)
  }
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

const currentTitle = computed(() => currentSession.value ? sessionLabel(currentSession.value) : '')
const currentApprovalMode = computed(() => currentSession.value?.env?.approval_mode || newSessionDraft.approval_mode)
const taskTemplates = computed(() => currentWorkspaceRoot.value ? uiText.chat.workspaceStarters : uiText.chat.webStarters)
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
  toolCalls,
  answeredInteractions,
  isRunning,
  runtimeNow,
  runError,
  pendingAsk,
  pendingApproval,
  processCollapsed,
})
const timelineNote = computed(() => {
  if (serverStatus.value === 'checking') return uiText.app.connectingToMoke
  if (serverStatus.value === 'offline') return uiText.app.disconnectedFromMoke
  if (runError.value) return runError.value
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
  window.addEventListener('resize', dismissCloseMenu)
  window.addEventListener('keydown', handleChatKeydown)
  window.addEventListener('resize', handleWindowResize)
  loadComposerReasoningEffort()
  initWorkspacePanels()
  await initBrowserWorkspace()

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
  closeMenuVersion++
  window.removeEventListener('resize', dismissCloseMenu)
  window.clearInterval(runtimeTimer)
  window.removeEventListener('keydown', handleChatKeydown)
  window.removeEventListener('resize', handleWindowResize)
  disposeBrowserWorkspace()
  disposeAgentSession()
  terminalTabs.value = []
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
    <template v-if="!scheduledTasksActive" #windowActions>
      <button
        v-if="traceCollapsed"
        class="trace-summary"
        type="button"
        :aria-label="uiText.header.showBrowser"
        :title="uiText.header.showBrowser"
        @click="toggleWorkspace"
      >
        <PanelRight :size="16" stroke-width="1.9" />
      </button>
    </template>

    <template #sidebar>
      <ChatSidebar :sessions="sortedSessions" :active-session-id="scheduledTasksActive ? '' : sessionId"
        :disabled="serverStatus !== 'online'" :running-session-ids="runningSessionIds" :settings-active="false"
        :new-session-active="!scheduledTasksActive && !sessionId"
        :scheduled-tasks-active="scheduledTasksActive" :session-label="sessionLabel"
        :session-meta="sessionMeta"
        @select-session="selectSession" @rename-session="renameSession" @archive-session="archiveSelectedSession"
        @pin-session="pinSession" @new-session="startNewSession" @open-settings="openSettings"
        />
    </template>

    <section v-if="!scheduledTasksActive" class="chat">
      <ChatHeader
        :title="currentTitle"
        subtitle=""
        :desktop-layout="desktopLayout"
        :sidebar-collapsed="sidebarCollapsed"
        :server-status="serverStatus"
        :server-status-label="serverStatusLabel"
        :workspace-root="currentWorkspaceRoot"
        @new-session="startNewSession"
        @toggle-sidebar="toggleSidebar"
      />

      <div class="chat-main" :class="{ 'is-empty': showEmptyState }">
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
            :key="pendingAsk.ask_id"
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
          :model-provider-id="activeModel?.providerId || ''"
          :model-options="composerModelOptions"
          :reasoning-effort="composerReasoningEffort"
          :reasoning-options="composerReasoningOptions"
          :approval-mode="currentApprovalMode"
          :native-workspace-picker="nativeWorkspacePicker"
          :workspace-root="draftWorkspaceRoot"
          :workspace-suggestions="recentWorkspaces"
          :workspace-entries="workspaceEntries"
          :skills="workspaceSkills"
          @update:input-value="input = $event"
          @update:reasoning-effort="composerReasoningEffort = $event"
          @update:approval-mode="updateApprovalMode"
          @select-model="selectModel"
          @update:workspace-root="updateDraftWorkspace"
          @choose-workspace-directory="chooseDraftWorkspaceDirectory"
          @choose-files="chooseFiles"
          @choose-workspace-entry="addFiles([$event])"
          @input="handleInput"
          @add-attachments="addAttachments" @remove-attachment="removeAttachment" @remove-file="removeFile"
          @enter="sendOnEnter" @submit="handlePrimaryAction" />
        <div v-if="showEmptyState" class="suggestion-grid">
          <button v-for="template in taskTemplates" :key="template.title" type="button" @click="applySuggestion(template.prompt)">
            <span>{{ template.title }}</span>
          </button>
        </div>
        </div>
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
      <div class="auxiliary-workspace">
        <div class="workspace-tabs-row" data-tauri-drag-region>
          <nav class="workspace-tabs" aria-label="Workspace tabs">
            <template v-for="key in workspaceTabOrder" :key="key">
            <button v-if="key.startsWith('browser-') && browserTabs.find((tab) => browserTabKey(tab) === key)"
              v-for="tab in browserTabs.filter((candidate) => browserTabKey(candidate) === key)"
              :key="browserTabKey(tab)"
              type="button"
              class="workspace-tab"
              :class="{ active: activeWorkspaceTabId() === browserTabKey(tab) }"
              :title="tab.title || tab.url || 'Browser'"
              @contextmenu="openBrowserTabMenu($event, tab)"
              @click="selectBrowserWorkspaceTab(tab)"
            >
              <img v-if="browserFavicon(tab)" :src="browserFavicon(tab)" alt="" aria-hidden="true" class="workspace-tab-favicon" />
              <Globe v-else :size="13" stroke-width="2" />
              <span>{{ tab.title || tab.url || 'Browser' }}</span>
              <span class="workspace-tab-close" role="button" aria-label="Close browser tab" @click.stop="void browserPanel?.closeTabs(tab, 'tab')">
                <X :size="11" stroke-width="2.2" />
              </span>
            </button>
            <button v-else-if="key.startsWith('terminal-') && terminalTabs.find((tab) => tab.id === key)"
              v-for="tab in terminalTabs.filter((candidate) => candidate.id === key)"
              :key="tab.id"
              type="button"
              class="workspace-tab workspace-tab-terminal"
              :class="{ active: activeWorkspaceTabId() === tab.id }"
              :title="tab.title"
              @contextmenu="openTerminalCloseMenu($event, tab.id)"
              @click="selectTerminalWorkspaceTab(tab.id)"
            >
              <SquareTerminal :size="13" stroke-width="2" />
              <span>{{ tab.title }}</span>
              <span class="workspace-tab-close" role="button" :aria-label="`Close ${tab.title}`" @click.stop="closeTerminalWorkspaceTab(tab.id)">
                <X :size="11" stroke-width="2.2" />
              </span>
            </button>
            </template>
          </nav>
          <div class="workspace-tab-actions">
            <button type="button" class="workspace-tab-add" aria-label="New browser tab" title="New browser tab" @click="createWorkspaceTab('browser')">
              <Plus :size="14" stroke-width="2.2" />
            </button>
            <button type="button" class="workspace-tab-menu-trigger" aria-label="Choose workspace type" title="Choose workspace type" aria-haspopup="menu" :aria-controls="workspaceMenuOpen ? 'workspace-create-menu' : undefined" :aria-expanded="workspaceMenuOpen" @click="toggleWorkspaceMenu" @keydown.down.prevent="toggleWorkspaceMenu" @keydown.up.prevent="toggleWorkspaceMenu">
              <ChevronDown :size="13" stroke-width="2.2" />
            </button>
          </div>
          <div class="workspace-panel-actions">
            <button
              type="button"
              class="workspace-expand-action"
              :aria-label="workspaceMaximized ? uiText.browser.restore : uiText.browser.maximize"
              :title="workspaceMaximized ? uiText.browser.restore : uiText.browser.maximize"
              :aria-pressed="Boolean(workspaceMaximized)"
              @click="toggleWorkspaceMaximized"
            >
              <Minimize2 v-if="workspaceMaximized" :size="14" stroke-width="2.2" />
              <Maximize2 v-else :size="14" stroke-width="2.2" />
            </button>
            <button
              type="button"
              class="workspace-hide-action"
              :aria-label="uiText.header.hideBrowser"
              :title="uiText.header.hideBrowser"
              @click="toggleWorkspace"
            >
              <PanelRight :size="16" stroke-width="1.9" />
            </button>
          </div>
        </div>
        <BrowserPanel v-show="auxiliaryMode === 'browser'" ref="browserPanel" :active="workspaceActive && !scheduledTasksActive && !traceCollapsed && auxiliaryMode === 'browser'" :maximized="workspaceMaximized" :show-tabs="false" :can-create-terminal="Boolean(currentWorkspaceRoot)" @workspace-menu-change="workspaceMenuOpen = $event" @create-workspace-tab="createWorkspaceTab" @state-change="handleBrowserStateChange" @toggle-maximized="toggleWorkspaceMaximized" />
        <TerminalPanel
          v-for="tab in terminalTabs"
          v-show="auxiliaryMode === 'terminal' && activeTerminalTabId === tab.id"
          :key="tab.id"
          :active="workspaceActive && !scheduledTasksActive && !traceCollapsed && auxiliaryMode === 'terminal' && activeTerminalTabId === tab.id"
          :cwd="tab.cwd"
          @close="closeTerminalWorkspaceTab(tab.id)"
        />
      </div>
      <Teleport to="body">
        <div v-if="workspaceCloseMenu" class="browser-tab-menu-backdrop" @click="closeWorkspaceMenu()" @contextmenu.prevent="closeWorkspaceMenu()" />
        <div v-if="workspaceCloseMenu" ref="closeMenuElement" class="browser-tab-context-menu" :style="{ left: `${workspaceCloseMenu.x}px`, top: `${workspaceCloseMenu.y}px` }" role="menu" aria-label="Tab actions" @keydown="handleCloseMenuKeydown" @contextmenu.prevent>
          <button type="button" role="menuitem" @click="closeWorkspaceTabsFromMenu('tab')">Close Tab</button>
          <button type="button" role="menuitem" :disabled="workspaceTabOrder.length < 2" @click="closeWorkspaceTabsFromMenu('others')">Close Other Tabs</button>
          <button type="button" role="menuitem" :disabled="workspaceTabOrder.indexOf(workspaceCloseMenu.id) === workspaceTabOrder.length - 1" @click="closeWorkspaceTabsFromMenu('right')">Close Tabs to the Right</button>
        </div>
      </Teleport>
    </template>
  </WorkspaceLayout>
</template>

