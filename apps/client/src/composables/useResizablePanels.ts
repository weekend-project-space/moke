import { computed, ref } from 'vue'

const SIDEBAR_WIDTH_KEY = 'moke.sidebar.width'
const SIDEBAR_COLLAPSED_KEY = 'moke.sidebar.collapsed'
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const WORKSPACE_WIDTH_KEY = 'moke.workspace.width'
const WORKSPACE_COLLAPSED_KEY = 'moke.workspace.collapsed'
const WORKSPACE_MIN_WIDTH = 360
const WORKSPACE_MAX_WIDTH = 1040
const DESKTOP_BREAKPOINT = 980
const CHAT_MIN_WIDTH = 420
const LAYOUT_GUTTER_WIDTH = 12

export function useResizablePanels() {
  const traceCollapsed = ref(true)
  const sidebarOpen = ref(false)
  const sidebarCollapsed = ref(false)
  const sidebarWidth = ref(268)
  const sidebarResizing = ref(false)
  const workspaceWidth = ref(560)
  const workspaceResizing = ref(false)

  const shellStyle = computed(() => ({
    '--sidebar-width': `${sidebarWidth.value}px`,
    '--workspace-width': `${workspaceWidth.value}px`,
  }))

  function isDesktopLayout() {
    return window.innerWidth > DESKTOP_BREAKPOINT
  }

  function isNarrowLayout() {
    return window.matchMedia(`(max-width: ${DESKTOP_BREAKPOINT}px)`).matches
  }

  function activeWorkspaceWidth() {
    return traceCollapsed.value ? 0 : workspaceWidth.value
  }

  function activeSidebarWidth() {
    return sidebarCollapsed.value && isDesktopLayout() ? 0 : sidebarWidth.value
  }

  function availablePanelWidth(otherPanelWidth: number) {
    if (!isDesktopLayout()) return Number.POSITIVE_INFINITY
    return Math.max(0, window.innerWidth - otherPanelWidth - CHAT_MIN_WIDTH - LAYOUT_GUTTER_WIDTH)
  }

  function clampWidth(width: number, min: number, max: number) {
    const rounded = Math.round(width)
    if (max < min) return Math.max(0, max)
    return Math.min(max, Math.max(min, rounded))
  }

  function clampSidebarWidth(width: number, workspaceTarget = activeWorkspaceWidth()) {
    const max = Math.min(SIDEBAR_MAX_WIDTH, availablePanelWidth(workspaceTarget))
    return clampWidth(width, SIDEBAR_MIN_WIDTH, max)
  }

  function setSidebarWidth(width: number, persist = false) {
    sidebarWidth.value = clampSidebarWidth(width)
    if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
  }

  function clampWorkspaceWidth(width: number, sidebarTarget = activeSidebarWidth()) {
    const max = Math.min(WORKSPACE_MAX_WIDTH, availablePanelWidth(sidebarTarget))
    return clampWidth(width, WORKSPACE_MIN_WIDTH, max)
  }

  function setWorkspaceWidth(width: number, persist = false) {
    workspaceWidth.value = clampWorkspaceWidth(width)
    fitPanelWidths('workspace')
    if (persist) localStorage.setItem(WORKSPACE_WIDTH_KEY, String(workspaceWidth.value))
  }

  function fitPanelWidths(changed: 'sidebar' | 'workspace' | 'window' = 'window') {
    if (!isDesktopLayout()) return

    if (changed === 'sidebar') {
      sidebarWidth.value = clampSidebarWidth(sidebarWidth.value)
      if (!traceCollapsed.value) workspaceWidth.value = clampWorkspaceWidth(workspaceWidth.value, activeSidebarWidth())
      return
    }

    if (!traceCollapsed.value) workspaceWidth.value = clampWorkspaceWidth(workspaceWidth.value, activeSidebarWidth())
    if (!sidebarCollapsed.value) sidebarWidth.value = clampSidebarWidth(sidebarWidth.value)
  }

  function openSidebar() {
    if (isDesktopLayout()) {
      sidebarCollapsed.value = false
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'false')
      fitPanelWidths('window')
      return
    }

    traceCollapsed.value = true
    sidebarOpen.value = true
  }

  function closeSidebar() {
    if (isDesktopLayout()) {
      sidebarCollapsed.value = true
      sidebarOpen.value = false
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true')
      stopSidebarResize()
      fitPanelWidths('window')
      return
    }

    sidebarOpen.value = false
  }

  function openWorkspace() {
    sidebarOpen.value = false
    traceCollapsed.value = false
    localStorage.setItem(WORKSPACE_COLLAPSED_KEY, 'false')
    fitPanelWidths('window')
  }

  function toggleWorkspace() {
    if (traceCollapsed.value) {
      openWorkspace()
      return
    }

    traceCollapsed.value = true
    localStorage.setItem(WORKSPACE_COLLAPSED_KEY, 'true')
    fitPanelWidths('window')
  }

  function closeTransientPanels() {
    sidebarOpen.value = false
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return

    if (sidebarOpen.value) {
      sidebarOpen.value = false
      return
    }

    if (!traceCollapsed.value) {
      traceCollapsed.value = true
      localStorage.setItem(WORKSPACE_COLLAPSED_KEY, 'true')
    }
  }

  function stopSidebarResize() {
    if (!sidebarResizing.value) return

    sidebarResizing.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', handleSidebarResize)
    window.removeEventListener('pointerup', stopSidebarResize)
    window.removeEventListener('pointercancel', stopSidebarResize)
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
  }

  function handleSidebarResize(event: PointerEvent) {
    if (!sidebarResizing.value) return
    setSidebarWidth(event.clientX)
    fitPanelWidths('sidebar')
  }

  function startSidebarResize(event: PointerEvent) {
    if (sidebarCollapsed.value || isNarrowLayout()) return

    event.preventDefault()
    sidebarResizing.value = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handleSidebarResize)
    window.addEventListener('pointerup', stopSidebarResize)
    window.addEventListener('pointercancel', stopSidebarResize)
  }

  function handleSidebarResizeKeydown(event: KeyboardEvent) {
    if (sidebarCollapsed.value) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

    event.preventDefault()
    const step = event.shiftKey ? 24 : 8
    setSidebarWidth(sidebarWidth.value + (event.key === 'ArrowRight' ? step : -step), true)
    fitPanelWidths('sidebar')
  }

  function stopWorkspaceResize() {
    if (!workspaceResizing.value) return

    workspaceResizing.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', handleWorkspaceResize)
    window.removeEventListener('pointerup', stopWorkspaceResize)
    window.removeEventListener('pointercancel', stopWorkspaceResize)
    localStorage.setItem(WORKSPACE_WIDTH_KEY, String(workspaceWidth.value))
  }

  function handleWorkspaceResize(event: PointerEvent) {
    if (!workspaceResizing.value) return
    setWorkspaceWidth(window.innerWidth - event.clientX)
  }

  function startWorkspaceResize(event: PointerEvent) {
    if (traceCollapsed.value || isNarrowLayout()) return

    event.preventDefault()
    workspaceResizing.value = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handleWorkspaceResize)
    window.addEventListener('pointerup', stopWorkspaceResize)
    window.addEventListener('pointercancel', stopWorkspaceResize)
  }

  function handleWorkspaceResizeKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

    event.preventDefault()
    const step = event.shiftKey ? 24 : 8
    setWorkspaceWidth(workspaceWidth.value + (event.key === 'ArrowLeft' ? step : -step), true)
  }

  function handleWindowResize() {
    fitPanelWidths('window')
  }

  function initResizablePanels() {
    const savedSidebarWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (Number.isFinite(savedSidebarWidth)) setSidebarWidth(savedSidebarWidth, true)

    sidebarCollapsed.value = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'

    const savedWorkspaceWidth = Number(localStorage.getItem(WORKSPACE_WIDTH_KEY))
    if (Number.isFinite(savedWorkspaceWidth)) setWorkspaceWidth(savedWorkspaceWidth, true)

    const savedWorkspaceCollapsed = localStorage.getItem(WORKSPACE_COLLAPSED_KEY)
    if (savedWorkspaceCollapsed !== null) traceCollapsed.value = savedWorkspaceCollapsed === 'true'

    fitPanelWidths('window')
  }

  function disposeResizablePanels() {
    stopSidebarResize()
    stopWorkspaceResize()
  }

  return {
    closeSidebar,
    closeTransientPanels,
    disposeResizablePanels,
    handleGlobalKeydown,
    handleSidebarResizeKeydown,
    handleWindowResize,
    handleWorkspaceResizeKeydown,
    initResizablePanels,
    openSidebar,
    openWorkspace,
    shellStyle,
    sidebarCollapsed,
    sidebarOpen,
    sidebarResizing,
    startSidebarResize,
    startWorkspaceResize,
    toggleWorkspace,
    traceCollapsed,
    workspaceResizing,
  }
}
