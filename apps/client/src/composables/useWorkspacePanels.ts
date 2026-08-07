import { ref } from 'vue'

const SIDEBAR_COLLAPSED_KEY = 'moke.sidebar.collapsed'
const WORKSPACE_COLLAPSED_KEY = 'moke.workspace.collapsed'
const DESKTOP_BREAKPOINT = 980

function readCollapsedState(key: string, fallback: boolean) {
  const stored = localStorage.getItem(key)
  return stored === null ? fallback : stored === 'true'
}

export function useWorkspacePanels() {
  // Read persisted layout before the first render so refresh does not animate from defaults.
  const traceCollapsed = ref(readCollapsedState(WORKSPACE_COLLAPSED_KEY, true))
  const desktopLayout = ref(false)
  const sidebarOpen = ref(false)
  const sidebarCollapsed = ref(readCollapsedState(SIDEBAR_COLLAPSED_KEY, false))
  const workspaceMaximized = ref(false)

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

  function closeWorkspace() {
    workspaceMaximized.value = false
    traceCollapsed.value = true
    localStorage.setItem(WORKSPACE_COLLAPSED_KEY, 'true')
  }

  function toggleWorkspace() {
    if (traceCollapsed.value) {
      openWorkspace()
      return
    }

    closeWorkspace()
  }

  function toggleWorkspaceMaximized() {
    if (traceCollapsed.value) openWorkspace()
    sidebarOpen.value = false
    workspaceMaximized.value = !workspaceMaximized.value
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

    if (workspaceMaximized.value) {
      workspaceMaximized.value = false
      return
    }

    if (!traceCollapsed.value) {
      closeWorkspace()
    }
  }

  function handleWindowResize() {
    refreshLayoutMode()
  }

  function initWorkspacePanels() {
    refreshLayoutMode()
  }

  return {
    closeSidebar,
    closeWorkspace,
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
    toggleWorkspaceMaximized,
    traceCollapsed,
    workspaceMaximized,
  }
}
