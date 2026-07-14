<script lang="ts">
import { ref as createSharedRef } from 'vue'

const SIDEBAR_WIDTH_KEY = 'moke.sidebar.width'
const AUXILIARY_WIDTH_KEY = 'moke.workspace.width'
const SIDEBAR_DEFAULT_WIDTH = 268
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const AUXILIARY_DEFAULT_WIDTH = 560
const AUXILIARY_MIN_WIDTH = 360
const AUXILIARY_MAX_WIDTH = 1280

const sharedSidebarWidth = createSharedRef(SIDEBAR_DEFAULT_WIDTH)
const sharedAuxiliaryWidth = createSharedRef(AUXILIARY_DEFAULT_WIDTH)
let sharedWidthsInitialized = false

function readStoredWidth(key: string, fallback: number, min: number, max: number) {
  const stored = localStorage.getItem(key)
  if (stored === null) return fallback

  const width = Number(stored)
  return Number.isFinite(width) ? Math.min(max, Math.max(min, Math.round(width))) : fallback
}

function initializeSharedWidths() {
  if (sharedWidthsInitialized) return

  sharedWidthsInitialized = true
  sharedSidebarWidth.value = readStoredWidth(
    SIDEBAR_WIDTH_KEY,
    SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
  )
  sharedAuxiliaryWidth.value = readStoredWidth(
    AUXILIARY_WIDTH_KEY,
    AUXILIARY_DEFAULT_WIDTH,
    AUXILIARY_MIN_WIDTH,
    AUXILIARY_MAX_WIDTH,
  )
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const MAIN_MIN_WIDTH = 420
const LAYOUT_GUTTER_WIDTH = 12
const DESKTOP_BREAKPOINT = 980

const props = defineProps<{
  auxiliaryLabel?: string
  auxiliaryVisible?: boolean
  closeSidebarLabel?: string
  sidebarCollapsed?: boolean
  sidebarLabel?: string
  sidebarOpen?: boolean
  sidebarPreview?: boolean
}>()

const emit = defineEmits<{
  closeSidebar: []
}>()

const layoutRoot = ref<HTMLElement | null>(null)
const auxiliaryPanel = ref<HTMLElement | null>(null)
const sidebarResizing = ref(false)
const auxiliaryResizing = ref(false)
const sidebarMaximum = ref(SIDEBAR_MAX_WIDTH)
const auxiliaryMaximum = ref(AUXILIARY_MAX_WIDTH)
let resizeObserver: ResizeObserver | null = null
let observedAuxiliary: HTMLElement | null = null

const layoutStyle = computed(() => ({
  '--sidebar-width': `${sharedSidebarWidth.value}px`,
  '--workspace-width': `${sharedAuxiliaryWidth.value}px`,
}))

function isDesktopLayout() {
  return window.innerWidth > DESKTOP_BREAKPOINT
}

function clampWidth(width: number, min: number, max: number) {
  const rounded = Math.round(width)
  if (max < min) return Math.max(0, max)
  return Math.min(max, Math.max(min, rounded))
}

function availableWidth() {
  return layoutRoot.value?.clientWidth || 0
}

function activeSidebarWidth() {
  return props.sidebarCollapsed && isDesktopLayout() ? 0 : sharedSidebarWidth.value
}

function activeAuxiliaryWidth() {
  return props.auxiliaryVisible ? sharedAuxiliaryWidth.value : 0
}

function sidebarWidthLimit(auxiliaryWidth = activeAuxiliaryWidth()) {
  const width = availableWidth()
  if (!width) return SIDEBAR_MAX_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, width - auxiliaryWidth - MAIN_MIN_WIDTH - LAYOUT_GUTTER_WIDTH)
}

function auxiliaryWidthLimit(sidebarWidth = activeSidebarWidth()) {
  const width = availableWidth()
  if (!width) return AUXILIARY_MAX_WIDTH
  return Math.min(AUXILIARY_MAX_WIDTH, width - sidebarWidth - MAIN_MIN_WIDTH - LAYOUT_GUTTER_WIDTH)
}

function setSidebarWidth(width: number, persist = false) {
  sidebarMaximum.value = sidebarWidthLimit()
  sharedSidebarWidth.value = clampWidth(width, SIDEBAR_MIN_WIDTH, sidebarMaximum.value)
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sharedSidebarWidth.value))
}

function setAuxiliaryWidth(width: number, persist = false) {
  auxiliaryMaximum.value = auxiliaryWidthLimit()
  sharedAuxiliaryWidth.value = clampWidth(width, AUXILIARY_MIN_WIDTH, auxiliaryMaximum.value)
  if (persist) localStorage.setItem(AUXILIARY_WIDTH_KEY, String(sharedAuxiliaryWidth.value))
}

function fitPanelWidths() {
  if (!isDesktopLayout() || !availableWidth()) return

  if (props.auxiliaryVisible) setAuxiliaryWidth(sharedAuxiliaryWidth.value)
  if (!props.sidebarCollapsed) setSidebarWidth(sharedSidebarWidth.value)
}

function handleSidebarResize(event: PointerEvent) {
  if (!sidebarResizing.value || !layoutRoot.value) return
  setSidebarWidth(event.clientX - layoutRoot.value.getBoundingClientRect().left)
}

function stopSidebarResize() {
  if (!sidebarResizing.value) return

  sidebarResizing.value = false
  restoreDocumentInteraction()
  window.removeEventListener('pointermove', handleSidebarResize)
  window.removeEventListener('pointerup', stopSidebarResize)
  window.removeEventListener('pointercancel', stopSidebarResize)
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sharedSidebarWidth.value))
}

function startSidebarResize(event: PointerEvent) {
  if (props.sidebarCollapsed || !isDesktopLayout()) return

  event.preventDefault()
  sidebarResizing.value = true
  suspendDocumentInteraction()
  window.addEventListener('pointermove', handleSidebarResize)
  window.addEventListener('pointerup', stopSidebarResize)
  window.addEventListener('pointercancel', stopSidebarResize)
}

function handleSidebarResizeKeydown(event: KeyboardEvent) {
  if (props.sidebarCollapsed || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return

  event.preventDefault()
  const step = event.shiftKey ? 24 : 8
  setSidebarWidth(sharedSidebarWidth.value + (event.key === 'ArrowRight' ? step : -step), true)
}

function handleAuxiliaryResize(event: PointerEvent) {
  if (!auxiliaryResizing.value || !layoutRoot.value) return
  const right = layoutRoot.value.getBoundingClientRect().right
  setAuxiliaryWidth(right - event.clientX)
}

function stopAuxiliaryResize() {
  if (!auxiliaryResizing.value) return

  auxiliaryResizing.value = false
  restoreDocumentInteraction()
  window.removeEventListener('pointermove', handleAuxiliaryResize)
  window.removeEventListener('pointerup', stopAuxiliaryResize)
  window.removeEventListener('pointercancel', stopAuxiliaryResize)
  localStorage.setItem(AUXILIARY_WIDTH_KEY, String(sharedAuxiliaryWidth.value))
}

function startAuxiliaryResize(event: PointerEvent) {
  if (!props.auxiliaryVisible || !isDesktopLayout()) return

  event.preventDefault()
  auxiliaryResizing.value = true
  suspendDocumentInteraction()
  window.addEventListener('pointermove', handleAuxiliaryResize)
  window.addEventListener('pointerup', stopAuxiliaryResize)
  window.addEventListener('pointercancel', stopAuxiliaryResize)
}

function handleAuxiliaryResizeKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

  event.preventDefault()
  const step = event.shiftKey ? 24 : 8
  setAuxiliaryWidth(
    sharedAuxiliaryWidth.value + (event.key === 'ArrowLeft' ? step : -step),
    true,
  )
}

function suspendDocumentInteraction() {
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function restoreDocumentInteraction() {
  if (sidebarResizing.value || auxiliaryResizing.value) return
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

function observeAuxiliaryPanel() {
  if (!resizeObserver || observedAuxiliary === auxiliaryPanel.value) return
  if (observedAuxiliary) resizeObserver.unobserve(observedAuxiliary)
  observedAuxiliary = auxiliaryPanel.value
  if (observedAuxiliary) resizeObserver.observe(observedAuxiliary)
}

watch(
  () => [props.auxiliaryVisible, props.sidebarCollapsed],
  async () => {
    await nextTick()
    observeAuxiliaryPanel()
    fitPanelWidths()
  },
)

onMounted(() => {
  initializeSharedWidths()
  resizeObserver = new ResizeObserver(fitPanelWidths)
  if (layoutRoot.value) resizeObserver.observe(layoutRoot.value)
  observeAuxiliaryPanel()
  fitPanelWidths()
})

onBeforeUnmount(() => {
  stopSidebarResize()
  stopAuxiliaryResize()
  resizeObserver?.disconnect()
})
</script>

<template>
  <main
    ref="layoutRoot"
    class="workspace-layout shell"
    :class="{
      'trace-collapsed': !auxiliaryVisible,
      'sidebar-collapsed': sidebarCollapsed,
      'sidebar-open': sidebarOpen,
      'sidebar-resizing': sidebarResizing,
      'workspace-resizing': auxiliaryResizing,
    }"
    :style="layoutStyle"
  >
    <button
      v-if="sidebarOpen"
      class="sidebar-scrim"
      type="button"
      :aria-label="closeSidebarLabel || 'Close sidebar'"
      @click="emit('closeSidebar')"
    ></button>

    <div class="sidebar-host" :class="{ 'sidebar-preview': sidebarPreview }">
      <slot name="sidebar" />
    </div>

    <div
      class="sidebar-resizer"
      role="separator"
      :aria-label="sidebarLabel || 'Resize sidebar'"
      aria-orientation="vertical"
      :aria-valuemin="SIDEBAR_MIN_WIDTH"
      :aria-valuemax="Math.max(SIDEBAR_MIN_WIDTH, sidebarMaximum)"
      :aria-valuenow="sharedSidebarWidth"
      tabindex="0"
      @keydown="handleSidebarResizeKeydown"
      @pointerdown="startSidebarResize"
    ></div>

    <div class="workspace-layout-main">
      <slot />
    </div>

    <div
      v-if="auxiliaryVisible"
      class="workspace-resizer"
      role="separator"
      :aria-label="auxiliaryLabel || 'Resize auxiliary panel'"
      aria-orientation="vertical"
      :aria-valuemin="AUXILIARY_MIN_WIDTH"
      :aria-valuemax="Math.max(AUXILIARY_MIN_WIDTH, auxiliaryMaximum)"
      :aria-valuenow="sharedAuxiliaryWidth"
      tabindex="0"
      @keydown="handleAuxiliaryResizeKeydown"
      @pointerdown="startAuxiliaryResize"
    ></div>

    <aside v-if="auxiliaryVisible" ref="auxiliaryPanel" class="workspace">
      <slot name="auxiliary" />
    </aside>
  </main>
</template>
