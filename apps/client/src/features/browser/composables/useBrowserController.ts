import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { browserApi, isNativeBrowserAvailable, type BrowserBounds, type BrowserPage } from '../api/browser'
import type { BrowserLinkOpenMode } from '../model/preferences'
import { waitForBrowserLayoutFrame } from '../services/browserLayout'

const MAX_TABS = 8

export function useBrowserController(options: {
  active: Ref<boolean>
  windowElement: Ref<HTMLElement | null>
  viewportElement: Ref<HTMLElement | null>
}) {
  const tabs = ref<BrowserPage[]>([])
  const activeTabKey = ref<string | null>(null)
  const address = ref('')
  const isEditingAddress = ref(false)
  const errorMessage = ref('')
  const isBusy = ref(false)
  const nativeAvailable = ref(false)
  let resizeObserver: ResizeObserver | null = null
  let unlistenBrowserState: (() => void) | null = null
  let boundsSyncFrame: number | null = null

  const activeTab = computed(() => tabs.value.find((tab) => tabKey(tab) === activeTabKey.value) || null)
  const canCreateTab = computed(() => nativeAvailable.value && !isBusy.value && tabs.value.length < MAX_TABS)
  const canGoBack = computed(() => Boolean(activeTab.value?.canGoBack && !isBusy.value))
  const canGoForward = computed(() => Boolean(activeTab.value?.canGoForward && !isBusy.value))
  const canReload = computed(() => Boolean(activeTab.value && !isBusy.value))

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

  function syncAddressFromPage(targetPage = activeTab.value) {
    address.value = formatAddress(targetPage?.url)
  }

  function applyState(result: { page: BrowserPage | null; pages?: BrowserPage[]; activePageId?: number | null }) {
    tabs.value = result.pages || []
    activeTabKey.value = result.activePageId == null ? null : `page-${result.activePageId}`
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
    const rect = (options.viewportElement.value || options.windowElement.value)?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0, width: 1, height: 1 }
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    }
  }

  async function syncBrowserBounds() {
    if (!nativeAvailable.value || !activeTab.value || !options.active.value) return
    try {
      await browserApi.resize(activeTab.value.pageId, getViewportBounds())
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
    }
  }

  function scheduleBoundsSync() {
    if (boundsSyncFrame !== null) return
    boundsSyncFrame = window.requestAnimationFrame(() => {
      boundsSyncFrame = null
      void syncBrowserBounds()
    })
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
      const tab = activeTab.value
      isEditingAddress.value = false
      if (!tab) {
        applyState(await browserApi.open({ url, visible: true, bounds: getViewportBounds() }))
        return
      }
      applyState(await browserApi.navigate({ pageId: tab.pageId, type: 'url', url }))
    })
  }

  async function createTab() {
    if (!canCreateTab.value) return
    await withBusy(async () => {
      applyState(await browserApi.open({ url: 'about:blank', visible: true, bounds: getViewportBounds() }))
      syncAddressFromPage()
      await nextTick()
      await syncBrowserBounds()
    })
  }

  async function openUrl(url: string, mode: BrowserLinkOpenMode = 'new-tab') {
    await withBusy(async () => {
      await nextTick()
      await waitForBrowserLayoutFrame()
      if (mode === 'current' && activeTab.value) {
        applyState(await browserApi.navigate({ pageId: activeTab.value.pageId, type: 'url', url }))
        return
      }
      applyState(await browserApi.open({ url, visible: true, bounds: getViewportBounds() }))
      await syncBrowserBounds()
    })
  }

  async function selectTab(tab: BrowserPage) {
    if (tabKey(tab) === activeTabKey.value) return
    await withBusy(async () => applyState(await browserApi.show(tab.pageId, getViewportBounds())))
  }

  async function closeTab(tab: BrowserPage) {
    await withBusy(async () => {
      applyState(await browserApi.close(tab.pageId))
      if (!activeTab.value) address.value = ''
    })
  }

  async function reloadPage(ignoreCache = false) {
    const currentPage = activeTab.value
    if (!currentPage) return
    await withBusy(async () => applyState(await browserApi.navigate({ pageId: currentPage.pageId, type: 'reload', ignoreCache })))
  }

  async function navigateHistory(type: 'back' | 'forward') {
    const currentPage = activeTab.value
    if (!currentPage) return
    await withBusy(async () => applyState(await browserApi.navigate({ pageId: currentPage.pageId, type })))
  }

  async function syncVisibility() {
    if (!nativeAvailable.value || !activeTab.value) return
    try {
      if (options.active.value) {
        await nextTick()
        await waitForBrowserLayoutFrame()
        applyState(await browserApi.show(activeTab.value.pageId, getViewportBounds()))
        await syncBrowserBounds()
        await waitForBrowserLayoutFrame()
        await syncBrowserBounds()
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
      if (options.active.value) await syncVisibility()
    })
    try {
      unlistenBrowserState = await browserApi.listenStateChanged((change) => applyState(change.state))
    } catch {
      unlistenBrowserState = null
    }
    window.addEventListener('resize', scheduleBoundsSync)
  })

  onUnmounted(() => {
    unlistenBrowserState?.()
    resizeObserver?.disconnect()
    if (boundsSyncFrame !== null) window.cancelAnimationFrame(boundsSyncFrame)
    boundsSyncFrame = null
    window.removeEventListener('resize', scheduleBoundsSync)
    if (activeTab.value) void browserApi.hide()
  })

  watch(() => options.active.value, () => void syncVisibility(), { flush: 'post' })
  watch(activeTabKey, () => void syncVisibility(), { flush: 'post' })
  watch(options.windowElement, (element) => {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (!element) return
    resizeObserver = new ResizeObserver(scheduleBoundsSync)
    resizeObserver.observe(element)
    scheduleBoundsSync()
  }, { flush: 'post' })

  return {
    tabs, activeTabKey, activeTab, address, isEditingAddress, errorMessage, isBusy, nativeAvailable,
    canCreateTab, canGoBack, canGoForward, canReload, tabKey, beginAddressEdit, endAddressEdit,
    submitAddress, createTab, openUrl, selectTab, closeTab, reloadPage, navigateHistory,
    getViewportBounds,
  }
}
