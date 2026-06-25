<script setup lang="ts">
import { PanelLeftClose, Plus, Search } from 'lucide-vue-next'
import { computed, ref } from 'vue'

type SessionSummary = {
  id: string
  title: string
  created_at: string
  updated_at: string
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

defineEmits<{
  close: []
  newSession: []
  selectSession: [id: string]
}>()

const searchQuery = ref('')
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
</script>

<template>
  <aside class="sidebar">
    <section class="brand">
      <div class="brand-header">
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
      <button
        v-for="session in filteredSessions"
        :key="session.id"
        class="session"
        :class="{ active: session.id === activeSessionId, running: isRunning && session.id === activeSessionId }"
        type="button"
        :disabled="disabled"
        @click="$emit('selectSession', session.id)"
      >
        <span class="session-line">
          <small>
            {{ session.preview || '新会话' }}
            <i v-if="isRunning && session.id === activeSessionId" aria-hidden="true"></i>
          </small>
          <time>{{ sessionMeta(session) }}</time>
        </span>
      </button>
    </section>
  </aside>
</template>
