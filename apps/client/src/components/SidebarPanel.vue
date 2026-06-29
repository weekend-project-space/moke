<script setup lang="ts">
import { Archive, PanelLeftClose, Pencil, Plus, Search } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

type SessionSummary = {
  id: string
  title: string
  created_at: string
  updated_at: string
  archived?: boolean
  preview?: string
  message_count?: number
}

const props = defineProps<{
  sessions: SessionSummary[]
  activeSessionId: string
  disabled: boolean
  isRunning: boolean
  sessionLabel: (session: SessionSummary) => string
  sessionMeta: (session: SessionSummary) => string
}>()

const emit = defineEmits<{
  archiveSession: [id: string]
  close: []
  newSession: []
  renameSession: [id: string, title: string]
  selectSession: [id: string]
}>()

const searchQuery = ref('')
const contextMenu = ref<{ session: SessionSummary; x: number; y: number } | null>(null)
const editingSessionId = ref('')
const editingTitle = ref('')
const editingInput = ref<HTMLInputElement | null>(null)
const editingSession = ref<SessionSummary | null>(null)

const filteredSessions = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return props.sessions

  return props.sessions.filter((session) => {
    const label = props.sessionLabel(session).toLowerCase()
    const preview = (session.preview || '').toLowerCase()
    return label.includes(query) || preview.includes(query)
  })
})

function clearSearch() {
  searchQuery.value = ''
}

function openContextMenu(event: MouseEvent, session: SessionSummary) {
  if (props.disabled) return
  event.preventDefault()
  contextMenu.value = {
    session,
    x: Math.min(event.clientX, window.innerWidth - 168),
    y: Math.min(event.clientY, window.innerHeight - 104),
  }
}

function closeContextMenu() {
  contextMenu.value = null
}

function startRename(session: SessionSummary) {
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
  closeContextMenu()
  emit('archiveSession', session.id)
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
    emit('renameSession', session.id, title)
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
  <aside class="sidebar" @click="closeContextMenu">
    <section class="brand">
      <div class="brand-header">
        <span class="brand-title">会话</span>
        <div class="brand-actions">
          <button class="new-session" type="button" :disabled="disabled" aria-label="新建会话" title="新建会话" @click="$emit('newSession')">
            <Plus :size="17" stroke-width="2.2" />
          </button>
          <button class="close-sidebar" type="button" aria-label="收起会话列表" title="收起会话列表" @click="$emit('close')">
            <PanelLeftClose :size="17" stroke-width="2.1" />
          </button>
        </div>
      </div>
      <label class="session-search">
        <Search :size="14" stroke-width="2.2" />
        <input v-model="searchQuery" type="search" placeholder="搜索会话" @keydown.esc.prevent="clearSearch" />
      </label>
    </section>

    <section class="session-list">
      <div v-if="sessions.length === 0" class="sidebar-empty">
        <strong>还没有会话</strong>
        <span>点右上角 + 开始一次新的对话。</span>
      </div>
      <div v-else-if="filteredSessions.length === 0" class="sidebar-empty">
        <strong>没有找到</strong>
        <span>换个关键词试试看。</span>
      </div>
      <article
        v-for="session in filteredSessions"
        v-else
        :key="session.id"
        class="session"
        :class="{ active: session.id === activeSessionId, running: isRunning && session.id === activeSessionId }"
        @contextmenu="openContextMenu($event, session)"
      >
        <button
          v-if="editingSessionId !== session.id"
          class="session-main"
          type="button"
          :disabled="disabled"
          @click="emit('selectSession', session.id)"
        >
          <span class="session-line">
            <small>
              {{ sessionLabel(session) }}
              <i v-if="isRunning && session.id === activeSessionId" aria-hidden="true"></i>
            </small>
            <time>{{ sessionMeta(session) }}</time>
          </span>
        </button>
        <form v-else class="session-main session-rename-form" @submit.prevent="submitRename(session)">
          <span class="session-line">
            <input
              ref="editingInput"
              v-model="editingTitle"
              type="text"
              aria-label="会话名称"
              @blur="submitRename()"
              @keydown.esc.prevent="cancelRename"
            />
            <time>{{ sessionMeta(session) }}</time>
          </span>
        </form>
        <button
          class="session-archive-hover"
          type="button"
          :disabled="disabled"
          aria-label="归档"
          title="归档"
          @click.stop="archiveSession(session)"
        >
          <Archive :size="13" stroke-width="2.1" />
        </button>
      </article>
    </section>
  </aside>

  <Teleport to="body">
    <div v-if="contextMenu" class="session-menu-backdrop" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu"></div>
    <div
      v-if="contextMenu"
      class="session-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      role="menu"
      @click.stop
      @keydown.esc.prevent="closeContextMenu"
    >
      <button type="button" role="menuitem" @click="startRename(contextMenu.session)">
        <Pencil :size="14" stroke-width="2.1" />
        <span>重命名</span>
      </button>
      <button type="button" role="menuitem" @click="archiveSession(contextMenu.session)">
        <Archive :size="14" stroke-width="2.1" />
        <span>归档</span>
      </button>
    </div>
  </Teleport>
</template>
