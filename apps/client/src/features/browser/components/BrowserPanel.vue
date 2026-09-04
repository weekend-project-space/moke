<script setup lang="ts">
import { ArrowLeft, ArrowRight, CheckCircle2, CircleAlert, Download, FolderOpen, Globe, LoaderCircle, Maximize2, Minimize2, Plus, RefreshCw, Trash2, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useBrowserController } from '../composables/useBrowserController'
import { formatBrowserAddressHost } from '../model/address'
import { browserApi, type BrowserDownloadChange, type BrowserLinkOpenMode, type BrowserPage } from '../api/browser'
import type { BrowserTabCloseScope } from '../model/tabClose'
import { uiText } from '../../../text/uiText'

const props = defineProps<{ active: boolean; maximized?: boolean }>()
const emit = defineEmits<{ toggleMaximized: [] }>()
const windowElement = ref<HTMLElement | null>(null)
const viewportElement = ref<HTMLElement | null>(null)
const tabsElement = ref<HTMLElement | null>(null)
const addressInput = ref<HTMLInputElement | null>(null)
const tabMenuElement = ref<HTMLElement | null>(null)
const downloadTrigger = ref<HTMLButtonElement | null>(null)
const downloadMenuElement = ref<HTMLElement | null>(null)
const failedFaviconKeys = ref(new Set<string>())
const tabLimitNotice = ref(false)
const downloads = ref<Array<BrowserDownloadChange & { key: string }>>([])
const downloadActionError = ref('')
const downloadMenu = ref<{ x: number; y: number } | null>(null)
const tabMenu = ref<{
  tab: BrowserPage
  trigger: HTMLElement | null
  x: number
  y: number
} | null>(null)
let viewportLayoutVersion = 0
let tabLimitTimer: number | undefined
let unlistenDownloads: (() => void) | null = null
let componentDisposed = false
const {
  tabs, activeTabKey, activeTab, address, isEditingAddress, errorMessage, isBusy, nativeAvailable, viewportPreview,
  canGoBack, canGoForward, canReload, isTabLimitReached, maxTabs, tabKey,
  beginAddressEdit, endAddressEdit, submitAddress, createTab, openUrl,
  selectTab, closeTabs, reloadPage, retryPage, navigateHistory, getViewportBounds,
  suspendViewport, resumeViewport,
} = useBrowserController({
  active: toRef(props, 'active'),
  windowElement,
  viewportElement,
  onViewportLayoutChange: handleViewportLayoutChange,
})

const addressValue = computed({
  get: () => isEditingAddress.value ? address.value : formatBrowserAddressHost(address.value),
  set: (value: string) => { address.value = value },
})
const activeDownloadCount = computed(() => downloads.value.filter((item) => item.status === 'downloading').length)

function handleAddressFocus() {
  if (isEditingAddress.value) return
  beginAddressEdit()
  void nextTick(() => {
    if (document.activeElement === addressInput.value) addressInput.value?.select()
  })
}

function cancelAddressEdit() {
  endAddressEdit()
  addressInput.value?.blur()
}

async function handleAddressSubmit() {
  await submitAddress()
  addressInput.value?.blur()
}

async function openTabMenu(event: MouseEvent, tab: BrowserPage) {
  const layoutVersion = viewportLayoutVersion
  const target = event.currentTarget
  const trigger = target instanceof HTMLElement
    ? target.querySelector<HTMLElement>('.browser-tab-select') || target
    : null
  if (downloadMenu.value) await closeDownloadMenu(false, false)
  if (!await suspendViewport()) return
  if (layoutVersion !== viewportLayoutVersion) {
    await resumeViewport()
    return
  }
  tabMenu.value = {
    tab,
    trigger,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 192)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 116)),
  }
  void nextTick(() => enabledTabMenuItems()[0]?.focus())
}

async function closeTabMenu(restoreFocus = false, resume = true) {
  const trigger = tabMenu.value?.trigger
  tabMenu.value = null
  if (restoreFocus && trigger) void nextTick(() => trigger.focus())
  if (resume) await resumeViewport()
}

function handleDownloadChange(change: BrowserDownloadChange) {
  const matchIndex = change.path
    ? downloads.value.findIndex((item) => item.path === change.path)
    : downloads.value.findIndex((item) => item.url === change.url && item.status === 'downloading')
  if (matchIndex >= 0) {
    const current = downloads.value[matchIndex]
    downloads.value.splice(matchIndex, 1, {
      ...current,
      ...change,
      path: change.path || current.path,
    })
    return
  }

  downloads.value.unshift({ ...change, key: `${change.path || change.url}:${Date.now()}` })
  downloads.value = downloads.value.slice(0, 20)
}

function downloadStatus(item: BrowserDownloadChange) {
  if (item.status === 'downloading') return uiText.browser.downloading
  if (item.status === 'completed') return uiText.browser.downloadCompleted
  return uiText.browser.downloadFailed
}

async function toggleDownloadMenu() {
  if (downloadMenu.value) {
    await closeDownloadMenu(true)
    return
  }
  if (tabMenu.value) await closeTabMenu(false, false)
  if (activeTab.value && !await suspendViewport()) return

  const trigger = downloadTrigger.value?.getBoundingClientRect()
  downloadActionError.value = ''
  downloadMenu.value = {
    x: Math.max(8, Math.min((trigger?.right || window.innerWidth) - 328, window.innerWidth - 336)),
    y: Math.max(8, Math.min((trigger?.bottom || 46) + 6, window.innerHeight - 340)),
  }
  void nextTick(() => downloadMenuElement.value?.focus())
}

async function closeDownloadMenu(restoreFocus = false, resume = true) {
  downloadMenu.value = null
  downloadActionError.value = ''
  if (restoreFocus) void nextTick(() => downloadTrigger.value?.focus())
  if (resume) await resumeViewport()
}

function clearDownloads() {
  downloads.value = downloads.value.filter((item) => item.status === 'downloading')
}

async function openDownload(item: BrowserDownloadChange, reveal: boolean) {
  if (!item.path || item.status !== 'completed') return
  downloadActionError.value = ''
  try {
    await browserApi.openDownload(item.path, reveal)
  } catch (error) {
    downloadActionError.value = error instanceof Error ? error.message : String(error)
  }
}

function handleViewportLayoutChange() {
  viewportLayoutVersion += 1
  if (tabMenu.value) void closeTabMenu()
  if (downloadMenu.value) void closeDownloadMenu()
}

function enabledTabMenuItems() {
  return Array.from(tabMenuElement.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])
}

function canCloseOtherTabs(tab: BrowserPage) {
  return tabs.value.some((candidate) => candidate.pageId !== tab.pageId)
}

function canCloseTabsToRight(tab: BrowserPage) {
  const index = tabs.value.findIndex((candidate) => candidate.pageId === tab.pageId)
  return index >= 0 && index < tabs.value.length - 1
}

function faviconSources(tab: BrowserPage) {
  return Array.from(new Set([...(tab.faviconUrls || []), tab.faviconUrl].filter(Boolean)))
}

function faviconKey(tab: BrowserPage, source: string) {
  return `${tab.pageId}:${source}`
}

function faviconSource(tab: BrowserPage) {
  return faviconSources(tab).find((source) => !failedFaviconKeys.value.has(faviconKey(tab, source))) || ''
}

function handleFaviconError(tab: BrowserPage, source: string) {
  if (!source) return
  failedFaviconKeys.value = new Set(failedFaviconKeys.value).add(faviconKey(tab, source))
}

function handleCreateTab() {
  if (!isTabLimitReached.value) {
    void createTab()
    return
  }
  tabLimitNotice.value = true
  if (tabLimitTimer !== undefined) window.clearTimeout(tabLimitTimer)
  tabLimitTimer = window.setTimeout(() => {
    tabLimitNotice.value = false
    tabLimitTimer = undefined
  }, 1800)
}

function handleTabsWheel(event: WheelEvent) {
  const element = tabsElement.value
  if (!element || element.scrollWidth <= element.clientWidth) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  element.scrollLeft += delta
  event.preventDefault()
}

async function handleCloseTabs(scope: BrowserTabCloseScope) {
  const tab = tabMenu.value?.tab
  if (!tab) return
  await closeTabMenu(false, false)
  await closeTabs(tab, scope)
  await resumeViewport()
}

function handleTabMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    void closeTabMenu(true)
    return
  }
  if (event.key === 'Tab') {
    void closeTabMenu()
    return
  }

  const items = enabledTabMenuItems()
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

watch(tabs, (pages) => {
  const menuPageId = tabMenu.value?.tab.pageId
  if (menuPageId !== undefined && !pages.some((page) => page.pageId === menuPageId)) void closeTabMenu()
})

watch(() => props.active, (active) => {
  if (!active && tabMenu.value) void closeTabMenu()
  if (!active && downloadMenu.value) void closeDownloadMenu()
})

watch(activeTabKey, async () => {
  await nextTick()
  tabsElement.value?.querySelector<HTMLElement>('.browser-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

onMounted(async () => {
  const unlisten = await browserApi.listenDownloadChanges(handleDownloadChange)
  if (componentDisposed) unlisten()
  else unlistenDownloads = unlisten
})

onUnmounted(() => {
  componentDisposed = true
  unlistenDownloads?.()
  if (tabLimitTimer !== undefined) window.clearTimeout(tabLimitTimer)
})

defineExpose({
  getBounds: getViewportBounds,
  openUrl: (url: string, mode?: BrowserLinkOpenMode) => openUrl(url, mode),
})
</script>

<template>
  <section class="browser-panel" :class="{ 'browser-panel-unavailable': !nativeAvailable }" @contextmenu.prevent>
    <div v-if="nativeAvailable" class="browser-controls">
      <div class="browser-tabs-row" data-tauri-drag-region>
        <nav ref="tabsElement" class="browser-tabs" data-tauri-drag-region :aria-label="uiText.browser.pages" @wheel="handleTabsWheel">
          <div v-for="tab in tabs" :key="tabKey(tab)" class="browser-tab" :class="{ active: tabKey(tab) === activeTabKey }" @contextmenu.prevent.stop="openTabMenu($event, tab)">
            <button type="button" class="browser-tab-select" @click="selectTab(tab)">
              <img v-if="faviconSource(tab)" class="browser-tab-favicon" :src="faviconSource(tab)" alt="" aria-hidden="true" draggable="false" referrerpolicy="no-referrer" @error="handleFaviconError(tab, faviconSource(tab))" />
              <Globe v-else :size="13" stroke-width="2.2" />
              <span>{{ tab.title || (tab.url === 'about:blank' ? uiText.browser.newPage : tab.url) || uiText.browser.newPage }}</span>
            </button>
            <button type="button" class="browser-tab-close" :aria-label="uiText.browser.closePage" :title="uiText.browser.closePage" @click.stop="closeTabs(tab, 'tab')">
              <X :size="12" stroke-width="2.3" />
            </button>
          </div>
          <button type="button" class="browser-tab-add" :disabled="isBusy" :aria-label="isTabLimitReached ? uiText.browser.pageLimitReached(maxTabs) : uiText.browser.newPage" :title="isTabLimitReached ? uiText.browser.pageLimitReached(maxTabs) : uiText.browser.newPage" @click="handleCreateTab">
            <Plus :size="14" stroke-width="2.2" />
          </button>
        </nav>
        <button type="button" class="browser-tabs-maximize" :aria-label="maximized ? uiText.browser.restore : uiText.browser.maximize" :title="maximized ? uiText.browser.restore : uiText.browser.maximize" :aria-pressed="Boolean(maximized)" @click="emit('toggleMaximized')">
          <Minimize2 v-if="maximized" :size="14" stroke-width="2.2" />
          <Maximize2 v-else :size="14" stroke-width="2.2" />
        </button>
        <span v-if="tabLimitNotice" class="browser-tab-limit-notice" role="status">{{ uiText.browser.pageLimitReached(maxTabs) }}</span>
      </div>

      <form class="browser-toolbar" @submit.prevent="handleAddressSubmit">
        <div class="browser-toolbar-nav">
          <button type="button" :disabled="!canGoBack" :aria-label="uiText.browser.back" :title="uiText.browser.back" @click="navigateHistory('back')"><ArrowLeft :size="15" stroke-width="2.2" /></button>
          <button type="button" :disabled="!canGoForward" :aria-label="uiText.browser.forward" :title="uiText.browser.forward" @click="navigateHistory('forward')"><ArrowRight :size="15" stroke-width="2.2" /></button>
          <button type="button" class="browser-toolbar-reload" :class="{ 'is-loading': Boolean(activeTab?.isLoading) }" :disabled="!canReload" :aria-label="uiText.browser.reload" :title="uiText.browser.reload" @click="reloadPage(false)"><RefreshCw :size="15" stroke-width="2.2" /></button>
        </div>
        <label :class="{ 'is-editing': isEditingAddress }">
          <input ref="addressInput" v-model="addressValue" type="text" spellcheck="false" :placeholder="uiText.browser.addressPlaceholder" :title="isEditingAddress ? undefined : address" @focus="handleAddressFocus" @blur="endAddressEdit" @keydown.escape.prevent="cancelAddressEdit" />
        </label>
        <button
          ref="downloadTrigger"
          type="button"
          class="browser-download-trigger"
          :class="{ active: activeDownloadCount > 0 }"
          :aria-label="uiText.browser.downloads"
          :title="uiText.browser.downloads"
          :aria-expanded="Boolean(downloadMenu)"
          @click="toggleDownloadMenu"
        >
          <Download :size="15" stroke-width="2.2" />
          <span v-if="downloads.length" aria-hidden="true">{{ Math.min(downloads.length, 99) }}</span>
        </button>
      </form>
    </div>

    <div ref="windowElement" class="browser-window-state">
      <div v-if="!nativeAvailable" class="browser-placeholder desktop-required">
        <Globe :size="24" stroke-width="2" />
        <strong>{{ uiText.browser.requiresDesktopTitle }}</strong>
        <span>{{ uiText.browser.requiresDesktopDescription }}</span>
      </div>
      <div v-else-if="errorMessage" class="browser-placeholder error">
        <Globe :size="24" stroke-width="2" />
        <strong>{{ uiText.browser.errorTitle }}</strong>
        <span>{{ errorMessage }}</span>
        <button type="button" @click="retryPage">
          <RefreshCw :size="14" stroke-width="2.2" />
          <span>{{ uiText.browser.retry }}</span>
        </button>
      </div>
      <div v-else-if="!activeTab" class="browser-placeholder">
        <Globe :size="24" stroke-width="2" />
        <strong>{{ uiText.browser.openPromptTitle }}</strong>
        <span>{{ uiText.browser.openPromptDescription }}</span>
      </div>
      <div v-else ref="viewportElement" class="browser-viewport">
        <img v-if="viewportPreview" class="browser-viewport-preview" :src="viewportPreview" alt="" aria-hidden="true" draggable="false" />
        <div v-if="activeTab.isLoading" class="browser-loading" role="status" :aria-label="uiText.browser.loading"></div>
      </div>
    </div>
  </section>

  <Teleport to="body">
    <div v-if="tabMenu" class="browser-tab-menu-backdrop" @click="closeTabMenu()" @contextmenu.prevent="closeTabMenu()"></div>
    <div
      v-if="tabMenu"
      ref="tabMenuElement"
      class="browser-tab-context-menu"
      :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
      role="menu"
      @click.stop
      @contextmenu.prevent
      @keydown="handleTabMenuKeydown"
    >
      <button type="button" role="menuitem" @click="handleCloseTabs('tab')">
        <span>{{ uiText.browser.closePage }}</span>
      </button>
      <button type="button" role="menuitem" :disabled="!canCloseOtherTabs(tabMenu.tab)" @click="handleCloseTabs('others')">
        <span>{{ uiText.browser.closeOtherPages }}</span>
      </button>
      <button type="button" role="menuitem" :disabled="!canCloseTabsToRight(tabMenu.tab)" @click="handleCloseTabs('right')">
        <span>{{ uiText.browser.closePagesToRight }}</span>
      </button>
    </div>

    <div v-if="downloadMenu" class="browser-download-backdrop" @click="closeDownloadMenu()" @contextmenu.prevent="closeDownloadMenu()"></div>
    <section
      v-if="downloadMenu"
      ref="downloadMenuElement"
      class="browser-download-menu"
      :style="{ left: `${downloadMenu.x}px`, top: `${downloadMenu.y}px` }"
      tabindex="-1"
      :aria-label="uiText.browser.downloads"
      @click.stop
      @contextmenu.prevent
      @keydown.escape.prevent="closeDownloadMenu(true)"
    >
      <header>
        <strong>{{ uiText.browser.downloads }}</strong>
        <button type="button" :disabled="!downloads.some((item) => item.status !== 'downloading')" :aria-label="uiText.browser.clearDownloads" :title="uiText.browser.clearDownloads" @click="clearDownloads">
          <Trash2 :size="14" stroke-width="2" />
        </button>
      </header>
      <p v-if="downloadActionError" class="browser-download-error" role="status">{{ downloadActionError }}</p>
      <p v-if="!downloads.length" class="browser-download-empty">{{ uiText.browser.noDownloads }}</p>
      <ul v-else>
        <li v-for="item in downloads" :key="item.key" :class="`is-${item.status}`">
          <button type="button" class="browser-download-file" :disabled="item.status !== 'completed'" :title="item.path || item.fileName" @click="openDownload(item, false)">
            <LoaderCircle v-if="item.status === 'downloading'" :size="16" stroke-width="2" />
            <CheckCircle2 v-else-if="item.status === 'completed'" :size="16" stroke-width="2" />
            <CircleAlert v-else :size="16" stroke-width="2" />
            <span>
              <strong>{{ item.fileName }}</strong>
              <small>{{ downloadStatus(item) }}</small>
            </span>
          </button>
          <button type="button" class="browser-download-reveal" :disabled="item.status !== 'completed' || !item.path" :aria-label="uiText.browser.revealDownloadedFile" :title="uiText.browser.revealDownloadedFile" @click="openDownload(item, true)">
            <FolderOpen :size="15" stroke-width="2" />
          </button>
        </li>
      </ul>
    </section>
  </Teleport>
</template>
