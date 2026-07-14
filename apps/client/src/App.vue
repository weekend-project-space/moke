<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ChatWorkspace } from './features/chat'
import type { BrowserLinkOpenMode } from './features/browser'
import { SettingsWorkspace } from './features/settings'
import { uiText } from './text/uiText'

type AppWorkspace = 'chat' | 'settings'

const activeWorkspace = ref<AppWorkspace>('chat')
const settingsDirty = ref(false)
const chatWorkspace = ref<InstanceType<typeof ChatWorkspace> | null>(null)
const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === 'tauri.localhost' ? 'http://127.0.0.1:4010' : '')

async function openSettings() {
  activeWorkspace.value = 'settings'
  await nextTick()
  document.querySelector<HTMLButtonElement>('.settings-navigation nav button')?.focus()
}

function closeSettings() {
  if (settingsDirty.value && !window.confirm(uiText.skills.discardChanges)) return false

  activeWorkspace.value = 'chat'
  settingsDirty.value = false
  void nextTick(() => chatWorkspace.value?.refreshSettings())
  return true
}

async function openBrowserFromSettings(request: { url: string; mode: BrowserLinkOpenMode }) {
  if (!closeSettings()) return
  await nextTick()
  await chatWorkspace.value?.openBrowser(request.url, request.mode)
}

function handleAppKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || activeWorkspace.value !== 'settings') return
  event.preventDefault()
  closeSettings()
}

onMounted(() => window.addEventListener('keydown', handleAppKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleAppKeydown))
</script>

<template>
  <ChatWorkspace
    v-show="activeWorkspace === 'chat'"
    ref="chatWorkspace"
    :active="activeWorkspace === 'chat'"
    @open-settings="openSettings"
  />
  <SettingsWorkspace
    v-if="activeWorkspace === 'settings'"
    :api-base="apiBase"
    @close="closeSettings"
    @dirty-change="settingsDirty = $event"
    @open-browser-url="openBrowserFromSettings"
  />
</template>
