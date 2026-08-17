<script setup lang="ts">
import { Archive, CalendarClock, Clock3, FolderClosed, FolderOpen, Folders, List, LoaderCircle, MoreHorizontal, Pencil, Pin, PinOff, Search, Settings, SquarePen, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { SessionSummary } from '../model/conversation'
import {
  groupSessionsByProject,
  type SessionProjectGroup,
} from '../presentation/sessionProjects'
import { uiText } from '../../../text/uiText'

type SessionViewMode = 'recent' | 'projects'

const SESSION_VIEW_STORAGE_KEY = 'moke.sidebar.session-view'
const PROJECT_SESSION_PREVIEW_LIMIT = 6

const props = defineProps<{
  sessions: SessionSummary[]
  activeSessionId: string
  disabled: boolean
  runningSessionIds: string[]
  settingsActive: boolean
  newSessionActive: boolean
  scheduledTasksActive: boolean
  sessionLabel: (session: SessionSummary) => string
  sessionMeta: (session: SessionSummary) => string
}>()

const router = useRouter()

const emit = defineEmits<{
  archiveSession: [id: string]
  newSession: []
  openSettings: []
  pinSession: [id: string, pinned: boolean]
  renameSession: [id: string, title: string]
  selectSession: [id: string]
}>()

const searchQuery = ref('')
const contextMenu = ref<{
  session: SessionSummary
  trigger: HTMLElement | null
  x: number
  y: number
} | null>(null)
const editingSessionId = ref('')
const editingTitle = ref('')
const editingInput = ref<HTMLInputElement | null>(null)
const editingSession = ref<SessionSummary | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const runningSessionIdSet = computed(() => new Set(props.runningSessionIds))
const viewMode = ref<SessionViewMode>(readSessionViewMode())
const collapsedProjects = ref(new Set<string>())
const expandedProjects = ref(new Set<string>())

const filteredSessions = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return props.sessions

  return props.sessions.filter((session) => {
    const label = props.sessionLabel(session).toLowerCase()
    const preview = (session.preview || '').toLowerCase()
    return label.includes(query) || preview.includes(query)
  })
})

const projectGroups = computed(() => groupSessionsByProject(filteredSessions.value, uiText.sidebar.noProject, uiText.sidebar.quickChats))
const allProjectGroups = computed(() => groupSessionsByProject(props.sessions, uiText.sidebar.noProject, uiText.sidebar.quickChats))

function readSessionViewMode(): SessionViewMode {
  try {
    return window.localStorage.getItem(SESSION_VIEW_STORAGE_KEY) === 'projects' ? 'projects' : 'recent'
  } catch {
    return 'recent'
  }
}

function setViewMode(mode: SessionViewMode) {
  viewMode.value = mode
  try {
    window.localStorage.setItem(SESSION_VIEW_STORAGE_KEY, mode)
  } catch {
    // The view still works when browser storage is unavailable.
  }
}

function toggleProject(key: string) {
  const next = new Set(collapsedProjects.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
    const nextExpanded = new Set(expandedProjects.value)
    nextExpanded.delete(key)
    expandedProjects.value = nextExpanded
  }
  collapsedProjects.value = next
}

function isProjectCollapsed(key: string) {
  return !searchQuery.value.trim() && collapsedProjects.value.has(key)
}

function visibleProjectSessions(group: SessionProjectGroup) {
  const showAll = viewMode.value !== 'projects'
    || Boolean(searchQuery.value.trim())
    || expandedProjects.value.has(group.key)
  return showAll ? group.sessions : group.sessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT)
}

function canShowMoreProjectSessions(group: SessionProjectGroup) {
  return viewMode.value === 'projects'
    && !searchQuery.value.trim()
    && !expandedProjects.value.has(group.key)
    && group.sessions.length > PROJECT_SESSION_PREVIEW_LIMIT
}

function showMoreProjectSessions(key: string) {
  expandedProjects.value = new Set(expandedProjects.value).add(key)
}

watch([() => props.activeSessionId, allProjectGroups], ([activeSessionId]) => {
  if (!activeSessionId) return
  const activeGroup = allProjectGroups.value.find((group) =>
    group.sessions.some((session) => session.id === activeSessionId),
  )
  if (!activeGroup) return

  if (collapsedProjects.value.has(activeGroup.key)) {
    const nextCollapsed = new Set(collapsedProjects.value)
    nextCollapsed.delete(activeGroup.key)
    collapsedProjects.value = nextCollapsed
  }

  if (activeGroup.sessions.findIndex((session) => session.id === activeSessionId) >= PROJECT_SESSION_PREVIEW_LIMIT) {
    expandedProjects.value = new Set(expandedProjects.value).add(activeGroup.key)
  }
}, { immediate: true })

function clearSearch() {
  searchQuery.value = ''
}

function openScheduledTasks() {
  void router.push({ name: 'tasks' })
}

function isScheduledSession(session: SessionSummary) {
  return session.title.startsWith('Scheduled: ')
}

function openContextMenu(event: MouseEvent, session: SessionSummary) {
  if (props.disabled) return
  event.preventDefault()
  const target = event.currentTarget
  const trigger = target instanceof HTMLElement
    ? target.querySelector<HTMLElement>('.session-main') || target
    : null
  showContextMenu(session, event.clientX, event.clientY, trigger)
}

function openSessionMenu(event: MouseEvent, session: SessionSummary) {
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  const rect = trigger?.getBoundingClientRect()
  showContextMenu(
    session,
    rect ? rect.right - 168 : event.clientX,
    rect ? rect.bottom + 4 : event.clientY,
    trigger,
  )
}

function showContextMenu(session: SessionSummary, x: number, y: number, trigger: HTMLElement | null) {
  contextMenu.value = {
    session,
    trigger,
    x: Math.max(8, Math.min(x, window.innerWidth - 176)),
    y: Math.max(8, Math.min(y, window.innerHeight - 146)),
  }
  void nextTick(() => enabledMenuItems()[0]?.focus())
}

function closeContextMenu(restoreFocus = false) {
  const trigger = contextMenu.value?.trigger
  contextMenu.value = null
  if (restoreFocus && trigger) void nextTick(() => trigger.focus())
}

function enabledMenuItems() {
  return Array.from(menuEl.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])
}

function handleContextMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeContextMenu(true)
    return
  }
  if (event.key === 'Tab') {
    closeContextMenu()
    return
  }

  const items = enabledMenuItems()
  if (!items.length) return
  const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
  let nextIndex: number | undefined
  if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length
  if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = items.length - 1
  if (nextIndex === undefined) return

  event.preventDefault()
  items[nextIndex]?.focus()
}

function startRename(session: SessionSummary) {
  if (isSessionRunning(session.id)) return
  closeContextMenu()
  editingSessionId.value = session.id
  editingTitle.value = props.sessionLabel(session)
  editingSession.value = session
  void nextTick(() => {
    editingInput.value?.focus()
    editingInput.value?.select()
  })
}

function archiveSession(session: SessionSummary) {
  if (isSessionRunning(session.id)) return
  closeContextMenu()
  emit('archiveSession', session.id)
}

function togglePinned(session: SessionSummary) {
  closeContextMenu(true)
  emit('pinSession', session.id, !session.pinned)
}

function isSessionRunning(id: string) {
  return runningSessionIdSet.value.has(id)
}

function cancelRename() {
  editingSessionId.value = ''
  editingTitle.value = ''
  editingSession.value = null
}

function submitRename(session = editingSession.value) {
  if (!session) return
  if (editingSessionId.value !== session.id) return

  const title = editingTitle.value.trim()
  if (title && title !== props.sessionLabel(session)) {
    emit('renameSession', session.id, isScheduledSession(session) ? `Scheduled: ${title}` : title)
  }
  cancelRename()
}

function handleOutsideRenamePointerDown(event: PointerEvent) {
  if (!editingSession.value) return
  if (event.target instanceof Element && event.target.closest('.session-rename-form')) return

  submitRename()
}

function handleWindowBlur() {
  submitRename()
}

onMounted(() => {
  window.addEventListener('pointerdown', handleOutsideRenamePointerDown, true)
  window.addEventListener('blur', handleWindowBlur)
})

onUnmounted(() => {
  window.removeEventListener('pointerdown', handleOutsideRenamePointerDown, true)
  window.removeEventListener('blur', handleWindowBlur)
})
</script>

<template>
  <aside class="sidebar" @click="closeContextMenu()" @contextmenu.prevent>
    <nav class="sidebar-primary-actions" aria-label="Workspace">
      <button type="button" class="sidebar-navigation-item" :class="{ active: newSessionActive }" :disabled="disabled" @click.stop="emit('newSession')">
        <SquarePen :size="15" stroke-width="2.1" />
        <span>{{ uiText.sidebar.newChat }}</span>
      </button>
      <button type="button" class="sidebar-navigation-item" :class="{ active: scheduledTasksActive }" @click.stop="openScheduledTasks">
        <CalendarClock :size="15" stroke-width="2.1" />
        <span>{{ uiText.sidebar.scheduledTasks }}</span>
      </button>
    </nav>

    <section class="sidebar-chat-browser">
      <div class="sidebar-chat-heading">
        <span class="sidebar-section-title">{{ uiText.sidebar.chats }}</span>
        <div class="session-view-switch" role="group" :aria-label="uiText.sidebar.viewMode">
          <button
            type="button"
            :class="{ active: viewMode === 'recent' }"
            :aria-pressed="viewMode === 'recent'"
            :aria-label="uiText.sidebar.recentView"
            :title="uiText.sidebar.recentView"
            @click="setViewMode('recent')"
          >
            <List :size="14" stroke-width="2.1" aria-hidden="true" />
          </button>
          <button
            type="button"
            :class="{ active: viewMode === 'projects' }"
            :aria-pressed="viewMode === 'projects'"
            :aria-label="uiText.sidebar.projectsView"
            :title="uiText.sidebar.projectsView"
            @click="setViewMode('projects')"
          >
            <Folders :size="14" stroke-width="2.1" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div class="session-search">
        <Search :size="14" stroke-width="2.2" />
        <input
          v-model="searchQuery"
          type="search"
          :aria-label="uiText.sidebar.search"
          :placeholder="uiText.sidebar.search"
          @keydown.esc.prevent="clearSearch"
        />
        <button
          v-if="searchQuery"
          class="session-search-clear"
          type="button"
          :aria-label="uiText.sidebar.clearSearch"
          :title="uiText.sidebar.clearSearch"
          @click="clearSearch"
        >
          <X :size="13" stroke-width="2.2" />
        </button>
      </div>
    </section>

    <section class="session-list">
      <div v-if="sessions.length === 0" class="sidebar-empty">
        <strong>{{ uiText.sidebar.emptyTitle }}</strong>
        <span>{{ uiText.sidebar.emptyDescription }}</span>
      </div>
      <div v-else-if="filteredSessions.length === 0" class="sidebar-empty">
        <strong>{{ uiText.sidebar.noResultsTitle }}</strong>
        <span>{{ uiText.sidebar.noResultsDescription }}</span>
      </div>
      <div v-else>
        <div
          v-for="group in viewMode === 'projects'
            ? projectGroups
            : [{ key: 'recent', label: '', root: '', sessions: filteredSessions }]"
          :key="group.key"
          class="session-project-group"
        >
          <button
            v-if="viewMode === 'projects'"
            class="session-project-heading"
            type="button"
            :aria-expanded="!isProjectCollapsed(group.key)"
            :title="group.root || group.label"
            @click="toggleProject(group.key)"
          >
            <FolderOpen v-if="!isProjectCollapsed(group.key)" :size="15" stroke-width="2.1" />
            <FolderClosed v-else :size="15" stroke-width="2.1" />
            <span>{{ group.label }}</span>
          </button>
          <div v-show="!isProjectCollapsed(group.key)">
            <article
              v-for="session in visibleProjectSessions(group)"
              :key="session.id"
              class="session"
              :class="{
                active: session.id === activeSessionId,
                manageable: !disabled && editingSessionId !== session.id,
              }"
              @contextmenu="openContextMenu($event, session)"
            >
              <button
                v-if="editingSessionId !== session.id"
                class="session-main sidebar-navigation-item"
                :class="{ active: session.id === activeSessionId }"
                type="button"
                :disabled="disabled"
                @click="emit('selectSession', session.id)"
              >
                <span class="session-line">
                  <small>
                    <span class="session-title-text">{{ sessionLabel(session) }}</span>
                    <span
                      v-if="isScheduledSession(session)"
                      class="session-origin-icon"
                      role="img"
                      :aria-label="uiText.sidebar.scheduledSessionOrigin"
                      :title="uiText.sidebar.scheduledSessionOrigin"
                    >
                      <Clock3 :size="12" stroke-width="2" aria-hidden="true" />
                    </span>
                    <Pin v-if="session.pinned" class="session-pin" :size="11" stroke-width="2.2" aria-hidden="true" />
                  </small>
                  <span class="session-meta" :class="{ 'is-running': isSessionRunning(session.id) }">
                    <time :aria-hidden="isSessionRunning(session.id)">{{ sessionMeta(session) }}</time>
                    <span
                      v-if="isSessionRunning(session.id)"
                      class="session-running-status"
                      role="status"
                      :aria-label="uiText.sidebar.running"
                      :title="uiText.sidebar.running"
                    >
                      <LoaderCircle :size="15" stroke-width="2.2" aria-hidden="true" />
                    </span>
                  </span>
                </span>
              </button>
              <form v-else class="session-main session-rename-form" @submit.prevent="submitRename(session)">
                <span class="session-line">
                  <input
                    ref="editingInput"
                    v-model="editingTitle"
                    type="text"
                    :aria-label="uiText.sidebar.chatName"
                    @blur="submitRename()"
                    @keydown.esc.prevent="cancelRename"
                  />
                  <span class="session-meta" :class="{ 'is-running': isSessionRunning(session.id) }">
                    <time :aria-hidden="isSessionRunning(session.id)">{{ sessionMeta(session) }}</time>
                    <span
                      v-if="isSessionRunning(session.id)"
                      class="session-running-status"
                      role="status"
                      :aria-label="uiText.sidebar.running"
                      :title="uiText.sidebar.running"
                    >
                      <LoaderCircle :size="15" stroke-width="2.2" aria-hidden="true" />
                    </span>
                  </span>
                </span>
              </form>
              <button
                v-if="!disabled && editingSessionId !== session.id"
                class="session-menu-trigger"
                type="button"
                aria-haspopup="menu"
                :aria-expanded="contextMenu?.session.id === session.id"
                :aria-label="uiText.sidebar.chatActions"
                :title="uiText.sidebar.chatActions"
                @click.stop="openSessionMenu($event, session)"
              >
                <MoreHorizontal :size="15" stroke-width="2.1" />
              </button>
            </article>
            <button
              v-if="canShowMoreProjectSessions(group)"
              class="session-project-show-more"
              type="button"
              @click="showMoreProjectSessions(group.key)"
            >
              {{ uiText.sidebar.showMore }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <footer class="sidebar-footer">
      <button
        class="sidebar-settings sidebar-navigation-item"
        type="button"
        :class="{ active: settingsActive }"
        :aria-label="uiText.sidebar.settings"
        :title="uiText.sidebar.settings"
        @click="emit('openSettings')"
      >
        <Settings :size="15" stroke-width="2.1" />
        <span>{{ uiText.sidebar.settings }}</span>
      </button>
    </footer>
  </aside>

  <Teleport to="body">
    <div v-if="contextMenu" class="session-menu-backdrop" @click="closeContextMenu()" @contextmenu.prevent="closeContextMenu()"></div>
    <div
      v-if="contextMenu"
      ref="menuEl"
      class="session-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      role="menu"
      @click.stop
      @keydown="handleContextMenuKeydown"
    >
      <button type="button" role="menuitem" @click="togglePinned(contextMenu.session)">
        <PinOff v-if="contextMenu.session.pinned" :size="14" stroke-width="2.1" />
        <Pin v-else :size="14" stroke-width="2.1" />
        <span>{{ contextMenu.session.pinned ? uiText.sidebar.unpin : uiText.sidebar.pin }}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="isSessionRunning(contextMenu.session.id)"
        @click="startRename(contextMenu.session)"
      >
        <Pencil :size="14" stroke-width="2.1" />
        <span>{{ uiText.sidebar.rename }}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        :disabled="isSessionRunning(contextMenu.session.id)"
        @click="archiveSession(contextMenu.session)"
      >
        <Archive :size="14" stroke-width="2.1" />
        <span>{{ uiText.sidebar.archive }}</span>
      </button>
    </div>
  </Teleport>
</template>
