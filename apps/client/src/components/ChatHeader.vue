<script setup lang="ts">
import { PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-vue-next'

defineProps<{
  title: string
  subtitle: string
  traceCollapsed: boolean
  serverStatus: 'checking' | 'online' | 'offline'
  serverStatusLabel: string
}>()

const emit = defineEmits<{
  openSidebar: []
  toggleWorkspace: []
}>()
</script>

<template>
  <header class="topbar">
    <button class="sidebar-toggle" type="button" aria-label="展开会话列表" title="展开会话列表" @click="emit('openSidebar')">
      <PanelLeftOpen :size="17" stroke-width="2.1" />
    </button>
    <div>
      <h2>{{ title }}</h2>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <button
      class="trace-summary"
      type="button"
      :aria-label="traceCollapsed ? '显示浏览器' : '隐藏浏览器'"
      :title="traceCollapsed ? '显示浏览器' : '隐藏浏览器'"
      @click="emit('toggleWorkspace')"
    >
      {{ traceCollapsed ? '显示浏览器' : '隐藏浏览器' }}
      <PanelRightOpen v-if="traceCollapsed" :size="14" stroke-width="2.2" />
      <PanelRightClose v-else :size="14" stroke-width="2.2" />
    </button>
    <span v-if="serverStatus !== 'online'" class="server-pill" :class="serverStatus">
      <i aria-hidden="true"></i>
      {{ serverStatusLabel }}
    </span>
  </header>
</template>
