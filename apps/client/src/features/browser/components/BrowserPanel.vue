<script setup lang="ts">
import { ArrowLeft, ArrowRight, Globe2, Maximize2, Minimize2, Plus, RefreshCw, X } from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref, toRef, watch } from 'vue'
import { useBrowserController } from '../composables/useBrowserController'
import { formatBrowserAddressHost } from '../model/address'
import type { BrowserLinkOpenMode } from '../model/preferences'
import type { BrowserPage } from '../api/browser'
import type { BrowserTabCloseScope } from '../model/tabClose'
import { uiText } from '../../../text/uiText'

const props = defineProps<{ active: boolean; maximized?: boolean }>()
const emit = defineEmits<{ toggleMaximized: [] }>()
const windowElement = ref<HTMLElement | null>(null)
const viewportElement = ref<HTMLElement | null>(null)
const tabsElement = ref<HTMLElement | null>(null)
const addressInput = ref<HTMLInputElement | null>(null)
const tabMenuElement = ref<HTMLElement | null>(null)
const failedFaviconKeys = ref(new Set<string>())
const tabLimitNotice = ref(false)
const tabMenu = ref<{
  tab: BrowserPage
  trigger: HTMLElement | null
  x: number
  y: number
} | null>(null)
let viewportLayoutVersion = 0
let tabLimitTimer: number | undefined
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

function handleViewportLayoutChange() {
  viewportLayoutVersion += 1
  if (tabMenu.value) void closeTabMenu()
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

function faviconKey(tab: BrowserPage) {
  return `${tab.pageId}:${tab.faviconUrl}`
}

function shouldShowFavicon(tab: BrowserPage) {
  return Boolean(tab.faviconUrl) && !failedFaviconKeys.value.has(faviconKey(tab))
}

function handleFaviconError(tab: BrowserPage) {
  failedFaviconKeys.value = new Set(failedFaviconKeys.value).add(faviconKey(tab))
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
})

watch(activeTabKey, async () => {
  await nextTick()
  tabsElement.value?.querySelector<HTMLElement>('.browser-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

onUnmounted(() => {
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
      <div class="browser-tabs-row">
        <nav ref="tabsElement" class="browser-tabs" :aria-label="uiText.browser.pages" @wheel="handleTabsWheel">
          <div v-for="tab in tabs" :key="tabKey(tab)" class="browser-tab" :class="{ active: tabKey(tab) === activeTabKey }" @contextmenu.prevent.stop="openTabMenu($event, tab)">
            <button type="button" class="browser-tab-select" @click="selectTab(tab)">
              <img v-if="shouldShowFavicon(tab)" class="browser-tab-favicon" :src="tab.faviconUrl" alt="" aria-hidden="true" draggable="false" referrerpolicy="no-referrer" @error="handleFaviconError(tab)" />
              <Globe2 v-else :size="13" stroke-width="2.2" />
              <span>{{ tab.title || (tab.url === 'about:blank' ? uiText.browser.newPage : tab.url) || uiText.browser.newPage }}</span>
            </button>
            <i v-if="tab.isLoading" aria-hidden="true"></i>
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
          <button type="button" :disabled="!canReload" :aria-label="uiText.browser.reload" :title="uiText.browser.reload" @click="reloadPage(false)"><RefreshCw :size="15" stroke-width="2.2" /></button>
        </div>
        <label :class="{ 'is-editing': isEditingAddress }">
          <input ref="addressInput" v-model="addressValue" type="text" spellcheck="false" :placeholder="uiText.browser.addressPlaceholder" :title="isEditingAddress ? undefined : address" @focus="handleAddressFocus" @blur="endAddressEdit" @keydown.escape.prevent="cancelAddressEdit" />
        </label>
      </form>
    </div>

    <div ref="windowElement" class="browser-window-state">
      <div v-if="!nativeAvailable" class="browser-placeholder desktop-required">
        <Globe2 :size="24" stroke-width="2" />
        <strong>{{ uiText.browser.requiresDesktopTitle }}</strong>
        <span>{{ uiText.browser.requiresDesktopDescription }}</span>
      </div>
      <div v-else-if="errorMessage" class="browser-placeholder error">
        <Globe2 :size="24" stroke-width="2" />
        <strong>{{ uiText.browser.errorTitle }}</strong>
        <span>{{ errorMessage }}</span>
        <button type="button" @click="retryPage">
          <RefreshCw :size="14" stroke-width="2.2" />
          <span>{{ uiText.browser.retry }}</span>
        </button>
      </div>
      <div v-else-if="!activeTab" class="browser-placeholder">
        <Globe2 :size="24" stroke-width="2" />
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
  </Teleport>
</template>
