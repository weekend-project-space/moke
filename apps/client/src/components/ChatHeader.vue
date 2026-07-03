<script setup lang="ts">
import { PanelLeft, PanelRight } from 'lucide-vue-next'
import { computed } from 'vue'

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
  toggleSidebar: []
  toggleWorkspace: []
}>()

const sidebarToggleLabel = computed(() =>
  props.desktopLayout && !props.sidebarCollapsed ? '收起对话列表' : '展开对话列表',
)
</script>

<template>
  <header class="topbar">
    <button class="sidebar-toggle" type="button" :aria-label="sidebarToggleLabel" :title="sidebarToggleLabel" @click="emit('toggleSidebar')">
      <PanelLeft :size="17" stroke-width="2.1" />
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
      <PanelRight :size="14" stroke-width="2.2" />
    </button>
    <span v-if="serverStatus !== 'online'" class="server-pill" :class="serverStatus">
      <i aria-hidden="true"></i>
      {{ serverStatusLabel }}
    </span>
  </header>
</template>
