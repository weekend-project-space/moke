<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { isNavigationFailure, RouterView, useRoute, useRouter } from 'vue-router'
import { ChatWorkspace } from './features/chat'
import { isChatRoute, router } from './router'
import { getCurrentTauriWindow, tauriListen } from './services/tauri'
import { uiText } from './text/uiText'

const settingsDirty = ref(false)
const chatWorkspace = ref<InstanceType<typeof ChatWorkspace> | null>(null)
const lastChatPath = ref('/chat')
const nativeAppWindow = getCurrentTauriWindow()
const isMacOs = Boolean(nativeAppWindow && (/Macintosh|Mac OS X/.test(navigator.userAgent) || navigator.platform.startsWith('Mac')))
const showCustomTitlebar = Boolean(nativeAppWindow && !isMacOs)
document.documentElement.classList.toggle('platform-macos', isMacOs)
document.documentElement.classList.toggle('platform-custom-titlebar', showCustomTitlebar)
let unlistenCloseRequested: (() => void) | null = null
let unlistenMenuEvents: Array<() => void> = []
let unlistenWindowResize: (() => void) | null = null
let appDisposed = false
const apiBase =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === 'tauri.localhost' ? 'http://127.0.0.1:4010' : '')
const route = useRoute()
const routeNavigator = useRouter()

router.beforeEach((to, from) => {
  if (from.name === 'settings' && to.fullPath !== from.fullPath && settingsDirty.value) {
    if (!window.confirm(uiText.settings.confirmDiscardModelChanges)) return false
    settingsDirty.value = false
  }
  return true
})

router.afterEach((to, from) => {
  if (isChatRoute(to)) lastChatPath.value = to.fullPath
  if (from.name === 'settings' && isChatRoute(to)) {
    settingsDirty.value = false
    void nextTick(() => chatWorkspace.value?.refreshSettings())
  }
})

async function openSettings() {
  if (isChatRoute(route)) lastChatPath.value = route.fullPath
  await routeNavigator.push({ name: 'settings', params: { tab: 'model' } })
  await nextTick()
  document.querySelector<HTMLButtonElement>('.settings-navigation nav button')?.focus()
}

async function newChatFromMenu() {
  if (route.name === 'settings' && !(await closeSettings())) return
  await nextTick()
  await chatWorkspace.value?.newSession()
}

async function closeSettings() {
  const failure = await routeNavigator.push(lastChatPath.value)
  return !isNavigationFailure(failure)
}

function handleAppKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || route.name !== 'settings') return
  event.preventDefault()
  void closeSettings()
}

async function syncMacTopInset() {
  const [isFullscreen, isMaximized] = await Promise.all([
    nativeAppWindow!.isFullscreen(),
    nativeAppWindow!.isMaximized(),
  ])
  if (!appDisposed) document.documentElement.classList.toggle('platform-macos-window-expanded', isFullscreen || isMaximized)
}

async function registerMacMenuListeners() {
  const registrations = await Promise.allSettled([
    tauriListen('app-menu:new-chat', () => void newChatFromMenu()),
    tauriListen('app-menu:settings', () => void openSettings()),
  ])
  const unlisteners: Array<() => void> = []
  for (const registration of registrations) {
    if (registration.status === 'fulfilled') unlisteners.push(registration.value)
    else console.error('Failed to register native menu listener', registration.reason)
  }
  if (appDisposed) unlisteners.forEach((unlisten) => unlisten())
  else unlistenMenuEvents = unlisteners
}

onMounted(async () => {
  window.addEventListener('keydown', handleAppKeydown)
  if (isMacOs) void registerMacMenuListeners()

  if (nativeAppWindow) {
    const unlisten = await nativeAppWindow.onCloseRequested(async (event) => {
      if (!settingsDirty.value) return
      event.preventDefault()
      if (!window.confirm(uiText.settings.confirmDiscardModelChanges)) return
      await nativeAppWindow.destroy()
    })
    if (appDisposed) unlisten()
    else unlistenCloseRequested = unlisten
  }

  if (isMacOs && nativeAppWindow) {
    void syncMacTopInset()
    const unlistenResize = await nativeAppWindow.onResized(() => void syncMacTopInset())
    if (appDisposed) unlistenResize()
    else unlistenWindowResize = unlistenResize
  }
})
onUnmounted(() => {
  appDisposed = true
  unlistenCloseRequested?.()
  unlistenMenuEvents.forEach((unlisten) => unlisten())
  unlistenWindowResize?.()
  document.documentElement.classList.remove('platform-macos-window-expanded')
  window.removeEventListener('keydown', handleAppKeydown)
})
</script>

<template>
  <header v-if="showCustomTitlebar" class="app-titlebar" data-tauri-decorum-tb />
  <RouterView v-slot="{ Component }">
    <KeepAlive :include="['ChatWorkspace']">
      <component
        :is="Component"
        v-if="isChatRoute(route)"
        ref="chatWorkspace"
        @open-settings="openSettings"
      />
    </KeepAlive>
    <component
      :is="Component"
      v-if="!isChatRoute(route)"
      :api-base="apiBase"
      @close="closeSettings"
      @dirty-change="settingsDirty = $event"
    />
  </RouterView>
</template>
