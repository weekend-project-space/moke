import { ref } from 'vue'

const SIDEBAR_COLLAPSED_KEY = 'moke.sidebar.collapsed'
const WORKSPACE_COLLAPSED_KEY = 'moke.workspace.collapsed'
const DESKTOP_BREAKPOINT = 980

export function useWorkspacePanels() {
  const traceCollapsed = ref(true)
  const desktopLayout = ref(false)
  const sidebarOpen = ref(false)
  const sidebarCollapsed = ref(false)

  function isDesktopLayout() {
    return window.innerWidth > DESKTOP_BREAKPOINT
  }

  function refreshLayoutMode() {
    desktopLayout.value = isDesktopLayout()
  }

  function openSidebar() {
    if (isDesktopLayout()) {
      sidebarCollapsed.value = false
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'false')
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
      return
    }

    sidebarOpen.value = false
  }

  function toggleSidebar() {
    if (isDesktopLayout()) {
      if (sidebarCollapsed.value) openSidebar()
      else closeSidebar()
      return
    }

    if (sidebarOpen.value) closeSidebar()
    else openSidebar()
  }

  function openWorkspace() {
    sidebarOpen.value = false
    traceCollapsed.value = false
    localStorage.setItem(WORKSPACE_COLLAPSED_KEY, 'false')
  }

  function toggleWorkspace() {
    if (traceCollapsed.value) {
      openWorkspace()
      return
    }

    traceCollapsed.value = true
    localStorage.setItem(WORKSPACE_COLLAPSED_KEY, 'true')
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

  function handleWindowResize() {
    refreshLayoutMode()
  }

  function initWorkspacePanels() {
    refreshLayoutMode()
    sidebarCollapsed.value = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'

    const savedWorkspaceCollapsed = localStorage.getItem(WORKSPACE_COLLAPSED_KEY)
    if (savedWorkspaceCollapsed !== null) traceCollapsed.value = savedWorkspaceCollapsed === 'true'
  }

  return {
    closeSidebar,
    closeTransientPanels,
    desktopLayout,
    handleGlobalKeydown,
    handleWindowResize,
    initWorkspacePanels,
    openWorkspace,
    sidebarCollapsed,
    sidebarOpen,
    toggleSidebar,
    toggleWorkspace,
    traceCollapsed,
  }
}
