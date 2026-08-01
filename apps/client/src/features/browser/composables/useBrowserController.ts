import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { browserApi, isNativeBrowserAvailable, type BrowserBounds, type BrowserPage } from '../api/browser'
import { loadBrowserPreferences, type BrowserLinkOpenMode } from '../model/preferences'
import { resolveBrowserAddress } from '../model/address'
import { pageIdsToClose, type BrowserTabCloseScope } from '../model/tabClose'
import { waitForBrowserLayoutFrame } from '../services/browserLayout'

const MAX_TABS = 8
const STATE_REFRESH_INTERVAL_MS = 250

export function useBrowserController(options: {
  active: Ref<boolean>
  windowElement: Ref<HTMLElement | null>
  viewportElement: Ref<HTMLElement | null>
  onViewportLayoutChange?: () => void
}) {
  const tabs = ref<BrowserPage[]>([])
  const activeTabKey = ref<string | null>(null)
  const address = ref('')
  const isEditingAddress = ref(false)
  const errorMessage = ref('')
  const isBusy = ref(false)
  const nativeAvailable = ref(false)
  const viewportPreview = ref('')
  let resizeObserver: ResizeObserver | null = null
  let unlistenBrowserState: (() => void) | null = null
  let boundsSyncFrame: number | null = null
  let stateRefreshTimer: number | null = null
  let stateRefreshInFlight = false
  let viewportSuspended = false
  let viewportTransition = 0

  const activeTab = computed(() => tabs.value.find((tab) => tabKey(tab) === activeTabKey.value) || null)
  const isTabLimitReached = computed(() => tabs.value.length >= MAX_TABS)
  const canCreateTab = computed(() => nativeAvailable.value && !isBusy.value && !isTabLimitReached.value)
  const canGoBack = computed(() => Boolean(activeTab.value?.canGoBack && !activeTab.value.isLoading && !isBusy.value))
  const canGoForward = computed(() => Boolean(activeTab.value?.canGoForward && !activeTab.value.isLoading && !isBusy.value))
  const canReload = computed(() => Boolean(activeTab.value && !isBusy.value))

  function tabKey(tab: BrowserPage) {
    return `page-${tab.pageId}`
  }

  function formatAddress(url?: string) {
    if (!url || url === 'about:blank') return ''
    return url
  }

  function syncAddressFromPage(targetPage = activeTab.value) {
    address.value = formatAddress(targetPage?.url)
  }

  function pagesMatch(current: BrowserPage[], next: BrowserPage[]) {
    return current.length === next.length && current.every((page, index) => {
      const candidate = next[index]
      return candidate
        && page.pageId === candidate.pageId
        && page.label === candidate.label
        && page.url === candidate.url
        && page.title === candidate.title
        && page.faviconUrl === candidate.faviconUrl
        && (page.faviconUrls || []).join('\u0000') === (candidate.faviconUrls || []).join('\u0000')
        && page.canGoBack === candidate.canGoBack
        && page.canGoForward === candidate.canGoForward
        && page.isLoading === candidate.isLoading
        && page.visible === candidate.visible
    })
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
    options.onViewportLayoutChange?.()
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
      const preferences = loadBrowserPreferences()
      const url = resolveBrowserAddress(address.value, preferences.searchEngine)
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

  async function closeTabs(tab: BrowserPage, scope: BrowserTabCloseScope) {
    const pageIds = pageIdsToClose(tabs.value.map((page) => page.pageId), tab.pageId, scope)
    if (!pageIds.length) return

    await withBusy(async () => {
      for (const pageId of pageIds) applyState(await browserApi.close(pageId))
      if (!activeTab.value) address.value = ''
    })
  }

  async function refreshActivePageState() {
    const pageId = activeTab.value?.pageId
    if (!nativeAvailable.value || !options.active.value || viewportSuspended || pageId == null || stateRefreshInFlight) return

    stateRefreshInFlight = true
    try {
      const result = await browserApi.refreshState(pageId)
      if (result.activePageId !== activeTab.value?.pageId || !pagesMatch(tabs.value, result.pages)) applyState(result)
    } catch {
      // Page teardown and navigation can briefly make the child WebView unavailable.
    } finally {
      stateRefreshInFlight = false
    }
  }

  async function retryPage() {
    await withBusy(async () => {
      const currentPage = activeTab.value
      applyState(currentPage
        ? await browserApi.navigate({ pageId: currentPage.pageId, type: 'reload' })
        : await browserApi.state())
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
      if (options.active.value && !viewportSuspended) {
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

  async function waitForPreviewImage(source: string) {
    const image = new Image()
    if (typeof image.decode === 'function') {
      image.src = source
      await image.decode()
      return
    }
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Browser preview could not be decoded'))
      image.src = source
    })
  }

  async function waitForPaint() {
    await nextTick()
    await waitForBrowserLayoutFrame()
    await waitForBrowserLayoutFrame()
  }

  async function suspendViewport() {
    if (!nativeAvailable.value || !activeTab.value || !options.active.value) return false
    if (viewportSuspended && viewportPreview.value) return true

    const transition = ++viewportTransition
    const pageId = activeTab.value.pageId
    try {
      const preview = await browserApi.capturePreview(pageId)
      await waitForPreviewImage(preview)
      if (transition !== viewportTransition || activeTab.value?.pageId !== pageId) return false

      viewportPreview.value = preview
      await waitForPaint()
      if (transition !== viewportTransition) return false

      viewportSuspended = true
      applyState(await browserApi.hide())
      return true
    } catch {
      if (transition === viewportTransition) viewportPreview.value = ''
      return false
    }
  }

  async function resumeViewport() {
    if (!viewportSuspended) return
    const transition = ++viewportTransition
    viewportSuspended = false
    await syncVisibility()
    await waitForPaint()
    if (transition !== viewportTransition) return
    viewportPreview.value = ''
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
    stateRefreshTimer = window.setInterval(() => void refreshActivePageState(), STATE_REFRESH_INTERVAL_MS)
    void refreshActivePageState()
    window.addEventListener('resize', scheduleBoundsSync)
  })

  onUnmounted(() => {
    unlistenBrowserState?.()
    resizeObserver?.disconnect()
    if (boundsSyncFrame !== null) window.cancelAnimationFrame(boundsSyncFrame)
    boundsSyncFrame = null
    if (stateRefreshTimer !== null) window.clearInterval(stateRefreshTimer)
    stateRefreshTimer = null
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
    viewportPreview,
    canCreateTab, canGoBack, canGoForward, canReload, isTabLimitReached, maxTabs: MAX_TABS,
    tabKey, beginAddressEdit, endAddressEdit,
    submitAddress, createTab, openUrl, selectTab, closeTabs, reloadPage, retryPage, navigateHistory,
    suspendViewport, resumeViewport,
    getViewportBounds,
  }
}
