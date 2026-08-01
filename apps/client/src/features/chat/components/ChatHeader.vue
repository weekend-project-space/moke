<script setup lang="ts">
import {
  Blocks,
  Check,
  ChevronDown,
  Code2,
  FolderOpen,
  GitBranch,
  PanelLeft,
  PanelRight,
  SquarePen,
  SquareTerminal,
} from 'lucide-vue-next'
import { computed, nextTick, ref, watch } from 'vue'
import { uiText } from '../../../text/uiText'

type WorkspaceOpener = {
  id: string
  name: string
}

const WORKSPACE_OPENER_KEY = 'moke.workspace.opener.v1'

const props = defineProps<{
  title: string
  subtitle: string
  desktopLayout: boolean
  sidebarCollapsed: boolean
  traceCollapsed: boolean
  serverStatus: 'checking' | 'online' | 'offline'
  serverStatusLabel: string
  workspaceRoot: string
}>()

const emit = defineEmits<{
  newSession: []
  toggleSidebar: []
  toggleWorkspace: []
}>()

const workspaceMenuEl = ref<HTMLElement | null>(null)
const workspaceMenuTrigger = ref<HTMLButtonElement | null>(null)
const workspaceMenuOpen = ref(false)
const workspaceOpeners = ref<WorkspaceOpener[]>([])
const workspaceOpenersLoading = ref(false)
const workspaceOpenError = ref('')
const openingWorkspaceWith = ref('')
const preferredWorkspaceOpenerId = ref(readPreferredWorkspaceOpener())

const sidebarToggleLabel = computed(() =>
  props.desktopLayout && !props.sidebarCollapsed ? uiText.header.collapseChatList : uiText.header.expandChatList,
)
const nativeWorkspaceOpening = computed(() => typeof window !== 'undefined' && Boolean(window.__TAURI__?.core?.invoke))
const currentWorkspaceOpener = computed(() =>
  workspaceOpeners.value.find((opener) => opener.id === preferredWorkspaceOpenerId.value)
  || workspaceOpeners.value.find((opener) => opener.id === 'explorer')
  || workspaceOpeners.value[0],
)
const openWorkspaceLabel = computed(() => {
  if (!props.workspaceRoot) return uiText.header.noWorkspace
  if (currentWorkspaceOpener.value) return uiText.header.openWorkspaceIn(currentWorkspaceOpener.value.name)
  return uiText.header.chooseWorkspaceApp
})

function readPreferredWorkspaceOpener() {
  try {
    return window.localStorage.getItem(WORKSPACE_OPENER_KEY) || ''
  } catch {
    return ''
  }
}

function workspaceOpenerIcon(id: string) {
  if (id === 'vscode') return Code2
  if (id === 'visual_studio') return Blocks
  if (id === 'explorer') return FolderOpen
  if (id === 'terminal') return SquareTerminal
  if (id === 'git_bash') return GitBranch
  return FolderOpen
}

async function loadWorkspaceOpeners() {
  const root = props.workspaceRoot
  const invoke = window.__TAURI__?.core?.invoke
  if (!root || !invoke) {
    workspaceOpeners.value = []
    return
  }

  workspaceOpenersLoading.value = true
  workspaceOpenError.value = ''
  try {
    const openers = await invoke<WorkspaceOpener[]>('list_workspace_openers', { root })
    if (root !== props.workspaceRoot) return
    workspaceOpeners.value = openers
    if (workspaceMenuOpen.value) void nextTick(() => enabledWorkspaceMenuItems()[0]?.focus())
  } catch (error) {
    if (root !== props.workspaceRoot) return
    workspaceOpeners.value = []
    workspaceOpenError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (root === props.workspaceRoot) workspaceOpenersLoading.value = false
  }
}

async function toggleWorkspaceMenu() {
  if (!props.workspaceRoot) return
  if (workspaceMenuOpen.value) {
    closeWorkspaceMenu(true)
    return
  }

  workspaceMenuOpen.value = true
  if (!workspaceOpeners.value.length && !workspaceOpenersLoading.value) await loadWorkspaceOpeners()
  void nextTick(() => enabledWorkspaceMenuItems()[0]?.focus())
}

function closeWorkspaceMenu(restoreFocus = false) {
  workspaceMenuOpen.value = false
  workspaceOpenError.value = ''
  if (restoreFocus) void nextTick(() => workspaceMenuTrigger.value?.focus())
}

function enabledWorkspaceMenuItems() {
  return Array.from(workspaceMenuEl.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])
}

function handleWorkspaceMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeWorkspaceMenu(true)
    return
  }
  if (event.key === 'Tab') {
    closeWorkspaceMenu()
    return
  }

  const items = enabledWorkspaceMenuItems()
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

async function openWorkspace(opener = currentWorkspaceOpener.value) {
  const invoke = window.__TAURI__?.core?.invoke
  if (!invoke || !props.workspaceRoot || !opener || openingWorkspaceWith.value) return

  openingWorkspaceWith.value = opener.id
  workspaceOpenError.value = ''
  try {
    await invoke('open_workspace_with', { root: props.workspaceRoot, openerId: opener.id })
    preferredWorkspaceOpenerId.value = opener.id
    try {
      window.localStorage.setItem(WORKSPACE_OPENER_KEY, opener.id)
    } catch {
      // Opening the workspace does not depend on preference persistence.
    }
    closeWorkspaceMenu()
  } catch (error) {
    workspaceOpenError.value = error instanceof Error ? error.message : String(error)
    workspaceMenuOpen.value = true
  } finally {
    openingWorkspaceWith.value = ''
  }
}

watch(() => props.workspaceRoot, () => {
  workspaceOpeners.value = []
  workspaceOpenError.value = ''
  workspaceMenuOpen.value = false
  if (props.workspaceRoot && nativeWorkspaceOpening.value) void loadWorkspaceOpeners()
}, { immediate: true })
</script>

<template>
  <header class="topbar">
    <div class="topbar-side topbar-left">
      <button class="sidebar-toggle" type="button" :aria-label="sidebarToggleLabel" :title="sidebarToggleLabel" @click="emit('toggleSidebar')">
        <PanelLeft :size="17" stroke-width="2.1" />
      </button>
      <button
        class="new-session"
        type="button"
        :disabled="serverStatus !== 'online'"
        :aria-label="uiText.header.newChat"
        :title="uiText.header.newChat"
        @click="emit('newSession')"
      >
        <SquarePen :size="16" stroke-width="2.1" />
      </button>
    </div>
    <div class="chat-title-block">
      <h2>{{ title }}</h2>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <div class="topbar-side topbar-right">
      <div v-if="nativeWorkspaceOpening" class="workspace-open-control">
        <button
          class="workspace-open-primary"
          type="button"
          :disabled="!workspaceRoot || !currentWorkspaceOpener || Boolean(openingWorkspaceWith)"
          :aria-label="openWorkspaceLabel"
          :title="openWorkspaceLabel"
          @click="openWorkspace()"
        >
          <component :is="workspaceOpenerIcon(currentWorkspaceOpener?.id || 'explorer')" :size="16" stroke-width="2" />
        </button>
        <button
          ref="workspaceMenuTrigger"
          class="workspace-open-trigger"
          type="button"
          :disabled="!workspaceRoot || Boolean(openingWorkspaceWith)"
          :aria-label="uiText.header.chooseWorkspaceApp"
          :aria-expanded="workspaceMenuOpen"
          aria-haspopup="menu"
          :title="workspaceRoot || uiText.header.noWorkspace"
          @click="toggleWorkspaceMenu"
        >
          <ChevronDown :size="14" stroke-width="2" />
        </button>
        <div v-if="workspaceMenuOpen" class="workspace-open-backdrop" @click="closeWorkspaceMenu()"></div>
        <div
          v-if="workspaceMenuOpen"
          ref="workspaceMenuEl"
          class="workspace-open-menu"
          role="menu"
          :aria-label="uiText.header.chooseWorkspaceApp"
          @keydown="handleWorkspaceMenuKeydown"
        >
          <button
            v-for="opener in workspaceOpeners"
            :key="opener.id"
            type="button"
            role="menuitem"
            :disabled="Boolean(openingWorkspaceWith)"
            @click="openWorkspace(opener)"
          >
            <component :is="workspaceOpenerIcon(opener.id)" :size="17" stroke-width="1.9" />
            <span>{{ opener.name }}</span>
            <Check v-if="currentWorkspaceOpener?.id === opener.id" :size="14" stroke-width="2.2" />
          </button>
          <p v-if="workspaceOpenersLoading">{{ uiText.header.loadingWorkspaceApps }}</p>
          <p v-else-if="workspaceOpenError" class="error" :title="workspaceOpenError">{{ uiText.header.workspaceOpenFailed }}</p>
          <p v-else-if="!workspaceOpeners.length">{{ uiText.header.noWorkspaceApps }}</p>
        </div>
      </div>
      <button
        class="trace-summary"
        type="button"
        :aria-label="traceCollapsed ? uiText.header.showBrowser : uiText.header.hideBrowser"
        :title="traceCollapsed ? uiText.header.showBrowser : uiText.header.hideBrowser"
        @click="emit('toggleWorkspace')"
      >
        <PanelRight :size="17" stroke-width="2.1" />
      </button>
      <span v-if="serverStatus !== 'online'" class="server-pill" :class="serverStatus">
        <i aria-hidden="true"></i>
        {{ serverStatusLabel }}
      </span>
    </div>
  </header>
</template>
