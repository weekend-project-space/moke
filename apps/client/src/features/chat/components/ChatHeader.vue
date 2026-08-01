<script setup lang="ts">
import { PanelLeft, PanelRight, SquarePen } from 'lucide-vue-next'
import { computed } from 'vue'
import { uiText } from '../../../text/uiText'

const props = defineProps<{
  title: string
  subtitle: string
  desktopLayout: boolean
  sidebarCollapsed: boolean
  traceCollapsed: boolean
  serverStatus: 'checking' | 'online' | 'offline'
  serverStatusLabel: string
}>()

const emit = defineEmits<{
  newSession: []
  toggleSidebar: []
  toggleWorkspace: []
}>()

const sidebarToggleLabel = computed(() =>
  props.desktopLayout && !props.sidebarCollapsed ? uiText.header.collapseChatList : uiText.header.expandChatList,
)
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
