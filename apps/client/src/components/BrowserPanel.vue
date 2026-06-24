<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  Plus,
  RefreshCw,
  X,
} from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { browserApi, isNativeBrowserAvailable, type BrowserBounds, type BrowserPage } from '../api/browser'

const props = defineProps<{
  active: boolean
}>()

const MAX_TABS = 8

const page = ref<BrowserPage | null>(null)
const tabs = ref<BrowserPage[]>([])
const activeTabKey = ref<string | null>(null)
const address = ref('')
const isEditingAddress = ref(false)
const errorMessage = ref('')
const isBusy = ref(false)
const nativeAvailable = ref(false)
const windowElement = ref<HTMLElement | null>(null)
const viewportElement = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null
let refreshTimer = 0
let syncTimer = 0
let unlistenBrowserState: (() => void) | null = null

const activeTab = computed(() => tabs.value.find((tab) => tabKey(tab) === activeTabKey.value) || null)
const activePage = computed(() => activeTab.value)
const canUseBrowser = computed(() => nativeAvailable.value)
const canCreateTab = computed(() => canUseBrowser.value && !isBusy.value && tabs.value.length < MAX_TABS)
const canGoBack = computed(() => Boolean(activePage.value?.canGoBack && !isBusy.value))
const canGoForward = computed(() => Boolean(activePage.value?.canGoForward && !isBusy.value))
const canReload = computed(() => Boolean(activePage.value && !isBusy.value))

function tabKey(tab: BrowserPage) {
  return `page-${tab.pageId}`
}

function normalizeInput(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`
}

function formatAddress(url?: string) {
  if (!url || url === 'about:blank') return ''
  return url
}

function syncAddressFromPage(targetPage = activePage.value) {
  address.value = formatAddress(targetPage?.url)
}

function applyState(result: { page: BrowserPage | null; pages?: BrowserPage[]; activePageId?: number | null }) {
  page.value = result.page
  tabs.value = result.pages || []
  activeTabKey.value = result.activePageId ? `page-${result.activePageId}` : activeTabKey.value
  if (!isEditingAddress.value && result.page && activeTabKey.value === `page-${result.page.pageId}`) {
    syncAddressFromPage(result.page)
  } else if (!isEditingAddress.value && !result.page) {
    address.value = ''
  }
}

function beginAddressEdit() {
  isEditingAddress.value = true
}

function endAddressEdit() {
  isEditingAddress.value = false
  syncAddressFromPage()
}

function getViewportBounds(): BrowserBounds {
  const rect = (viewportElement.value || windowElement.value)?.getBoundingClientRect()

  if (!rect) {
    return { x: 0, y: 0, width: 1, height: 1 }
  }

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

async function syncBrowserBounds() {
  if (!nativeAvailable.value || !activePage.value || !props.active) return

  try {
    await browserApi.resize(activePage.value.pageId, getViewportBounds())
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function scheduleStateRefresh() {
  if (refreshTimer) window.clearTimeout(refreshTimer)

  refreshTimer = window.setTimeout(async () => {
    refreshTimer = 0
    if (!nativeAvailable.value || !activePage.value) return

    try {
      applyState(await browserApi.state())
    } catch {
      // The next explicit browser action will surface any persistent error.
    }
  }, 900)
}

function stopStateSync() {
  if (!syncTimer) return

  window.clearInterval(syncTimer)
  syncTimer = 0
}

function startStateSync() {
  stopStateSync()
  if (!nativeAvailable.value || !props.active || !activePage.value) return

  syncTimer = window.setInterval(async () => {
    if (!nativeAvailable.value || !props.active || !activePage.value) return

    try {
      applyState(await browserApi.refreshState(activePage.value.pageId))
    } catch {
      // Native page-load events and explicit browser actions still surface persistent errors.
    }
  }, 800)
}

async function withBusy(action: () => Promise<void>) {
  if (isBusy.value) return

  isBusy.value = true
  errorMessage.value = ''
  try {
    await action()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isBusy.value = false
  }
}

async function submitAddress() {
  await withBusy(async () => {
    const url = normalizeInput(address.value)
    const tab = activePage.value
    isEditingAddress.value = false

    if (!tab) {
      applyState(await browserApi.open({
        url,
        visible: true,
        bounds: getViewportBounds(),
      }))
      scheduleStateRefresh()
      return
    }

    applyState(await browserApi.navigate({
      pageId: tab.pageId,
      type: 'url',
      url,
    }))
    scheduleStateRefresh()
  })
}

async function createTab() {
  if (!canCreateTab.value) return

  await withBusy(async () => {
    applyState(await browserApi.open({
      url: 'about:blank',
      visible: true,
      bounds: getViewportBounds(),
    }))
    syncAddressFromPage()
    await nextTick()
    await syncBrowserBounds()
    scheduleStateRefresh()
  })
}

async function selectTab(tab: BrowserPage) {
  if (tabKey(tab) === activeTabKey.value) return

  await withBusy(async () => {
    applyState(await browserApi.show(tab.pageId, getViewportBounds()))
    scheduleStateRefresh()
  })
}

async function closeTab(tab: BrowserPage) {
  await withBusy(async () => {
    applyState(await browserApi.close(tab.pageId))
    if (!activePage.value) address.value = ''
  })
}

async function reloadPage(ignoreCache = false) {
  const currentPage = activePage.value
  if (!currentPage) return

  await withBusy(async () => {
    applyState(await browserApi.navigate({
      pageId: currentPage.pageId,
      type: 'reload',
      ignoreCache,
    }))
    scheduleStateRefresh()
  })
}

async function navigateHistory(type: 'back' | 'forward') {
  const currentPage = activePage.value
  if (!currentPage) return

  await withBusy(async () => {
    applyState(await browserApi.navigate({
      pageId: currentPage.pageId,
      type,
    }))
    scheduleStateRefresh()
  })
}

async function syncVisibility() {
  if (!nativeAvailable.value || !activePage.value) return

  try {
    if (props.active) {
      await nextTick()
      applyState(await browserApi.show(activePage.value.pageId, getViewportBounds()))
    } else {
      applyState(await browserApi.hide())
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(async () => {
  nativeAvailable.value = isNativeBrowserAvailable()

  if (!nativeAvailable.value) return

  await withBusy(async () => {
    applyState(await browserApi.state())
    if (props.active) await syncVisibility()
  })

  try {
    unlistenBrowserState = await browserApi.listenStateChanged((result) => {
      applyState(result)
    })
  } catch {
    unlistenBrowserState = null
  }

  startStateSync()
  window.addEventListener('resize', syncBrowserBounds)
})

onUnmounted(() => {
  if (refreshTimer) window.clearTimeout(refreshTimer)
  stopStateSync()
  unlistenBrowserState?.()
  unlistenBrowserState = null
  resizeObserver?.disconnect()
  window.removeEventListener('resize', syncBrowserBounds)
  if (activePage.value) void browserApi.hide()
})

watch(
  () => props.active,
  () => {
    void syncVisibility()
    startStateSync()
  },
  { flush: 'post' },
)

watch(
  activeTabKey,
  () => {
    startStateSync()
  },
  { flush: 'post' },
)

watch(
  windowElement,
  (element) => {
    resizeObserver?.disconnect()
    resizeObserver = null

    if (!element) return

    resizeObserver = new ResizeObserver(() => {
      void syncBrowserBounds()
    })
    resizeObserver.observe(element)
    void syncBrowserBounds()
  },
  { flush: 'post' },
)
</script>

<template>
  <section class="browser-panel">
    <nav class="browser-tabs" aria-label="浏览器页面">
      <div
        v-for="tab in tabs"
        :key="tabKey(tab)"
        class="browser-tab"
        :class="{ active: tabKey(tab) === activeTabKey }"
      >
        <button type="button" class="browser-tab-select" @click="selectTab(tab)">
          <Globe2 :size="13" stroke-width="2.2" />
          <span>{{ tab.title || (tab.url === 'about:blank' ? '新页面' : tab.url) || '新页面' }}</span>
        </button>
        <i v-if="tab.isLoading" aria-hidden="true"></i>
        <button type="button" class="browser-tab-close" aria-label="关闭页面" title="关闭页面" @click="closeTab(tab)">
          <X :size="12" stroke-width="2.3" />
        </button>
      </div>
      <button type="button" class="browser-tab-add" :disabled="!canCreateTab" aria-label="新建页面" title="新建页面" @click="createTab">
        <Plus :size="14" stroke-width="2.2" />
      </button>
    </nav>

    <form class="browser-toolbar" @submit.prevent="submitAddress">
      <button type="button" :disabled="!canGoBack" aria-label="后退" title="后退" @click="navigateHistory('back')">
        <ArrowLeft :size="15" stroke-width="2.2" />
      </button>
      <button type="button" :disabled="!canGoForward" aria-label="前进" title="前进" @click="navigateHistory('forward')">
        <ArrowRight :size="15" stroke-width="2.2" />
      </button>
      <button type="button" :disabled="!canReload" aria-label="刷新" title="刷新" @click="reloadPage(false)">
        <RefreshCw :size="15" stroke-width="2.2" />
      </button>
      <label>
        <Globe2 :size="14" stroke-width="2.2" />
        <input
          v-model="address"
          type="text"
          spellcheck="false"
          placeholder="输入网址"
          @focus="beginAddressEdit"
          @blur="endAddressEdit"
        />
      </label>
    </form>

    <div ref="windowElement" class="browser-window-state">
      <div v-if="!nativeAvailable" class="browser-placeholder">
        <Globe2 :size="24" stroke-width="2" />
        <strong>需要在 Tauri 桌面壳中使用</strong>
        <span>网页会嵌入到右侧浏览区域中。</span>
      </div>
      <div v-else-if="errorMessage" class="browser-placeholder error">
        <strong>{{ errorMessage }}</strong>
      </div>
      <div v-else-if="!activePage" class="browser-placeholder">
        <Globe2 :size="24" stroke-width="2" />
        <strong>输入网址后访问</strong>
        <span>页面会嵌入到下方区域，工具栏保留控制和状态。</span>
      </div>
      <div v-else ref="viewportElement" class="browser-viewport">
        <div v-if="activePage.isLoading" class="browser-loading">
          <Globe2 :size="18" stroke-width="2" />
          <span>加载中</span>
        </div>
      </div>
    </div>
  </section>
</template>

