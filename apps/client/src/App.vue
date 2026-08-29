<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { isNavigationFailure, RouterView, useRoute, useRouter } from 'vue-router'
import { ChatWorkspace } from './features/chat'
import { isChatRoute, router } from './router'
import { uiText } from './text/uiText'

type NativeAppWindow = {
  destroy(): Promise<void>
  onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>
  onResized(handler: () => void): Promise<() => void>
  isFullscreen(): Promise<boolean>
  isMaximized(): Promise<boolean>
}

const settingsDirty = ref(false)
const chatWorkspace = ref<InstanceType<typeof ChatWorkspace> | null>(null)
const fileMenu = ref(false)
const fileMenuElement = ref<HTMLElement | null>(null)
const fileMenuTrigger = ref<HTMLButtonElement | null>(null)
const lastChatPath = ref('/chat')
const nativeAppWindow = (window.__TAURI__ as typeof window.__TAURI__ & {
  window?: { getCurrentWindow(): NativeAppWindow }
})?.window?.getCurrentWindow()
const isMacOs = Boolean(nativeAppWindow && (/Macintosh|Mac OS X/.test(navigator.userAgent) || navigator.platform.startsWith('Mac')))
const showCustomTitlebar = Boolean(nativeAppWindow && !isMacOs)
document.documentElement.classList.toggle('platform-macos', isMacOs)
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
  closeFileMenu()
  if (isChatRoute(route)) lastChatPath.value = route.fullPath
  await routeNavigator.push({ name: 'settings', params: { tab: 'model' } })
  await nextTick()
  document.querySelector<HTMLButtonElement>('.settings-navigation nav button')?.focus()
}

async function newChatFromMenu() {
  closeFileMenu()
  if (route.name === 'settings' && !(await closeSettings())) return
  await nextTick()
  await chatWorkspace.value?.newSession()
}

function toggleFileMenu() {
  fileMenu.value = !fileMenu.value
  if (fileMenu.value) void nextTick(() => enabledFileMenuItems()[0]?.focus())
}

function closeFileMenu(restoreFocus = false) {
  fileMenu.value = false
  if (restoreFocus) void nextTick(() => fileMenuTrigger.value?.focus())
}

function enabledFileMenuItems() {
  return Array.from(fileMenuElement.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])
}

function handleFileMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeFileMenu(true)
    return
  }
  if (event.key === 'Tab') {
    closeFileMenu()
    return
  }

  const items = enabledFileMenuItems()
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

onMounted(async () => {
  window.addEventListener('keydown', handleAppKeydown)
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

    const listen = window.__TAURI__?.event?.listen
    if (listen) {
      const menuUnlisteners = await Promise.all([
        listen('app-menu:new-chat', () => void newChatFromMenu()),
        listen('app-menu:settings', () => void openSettings()),
      ])
      if (appDisposed) menuUnlisteners.forEach((unlisten) => unlisten())
      else unlistenMenuEvents = menuUnlisteners
    }
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
  <header v-if="showCustomTitlebar" class="app-titlebar" data-tauri-decorum-tb>
    <div class="app-menu">
      <button ref="fileMenuTrigger" type="button" class="app-menu-trigger" aria-haspopup="menu" :aria-expanded="fileMenu" @click="toggleFileMenu">
        {{ uiText.app.fileMenu }}
      </button>
      <div v-if="fileMenu" class="app-menu-backdrop" @click="closeFileMenu()"></div>
      <div v-if="fileMenu" ref="fileMenuElement" class="app-menu-popover" role="menu" :aria-label="uiText.app.fileMenu" @keydown="handleFileMenuKeydown">
        <button type="button" role="menuitem" @click="newChatFromMenu">{{ uiText.app.newChat }}</button>
        <button type="button" role="menuitem" @click="openSettings">{{ uiText.app.settings }}</button>
      </div>
    </div>
    <div class="app-titlebar-drag" data-tauri-drag-region></div>
  </header>
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
