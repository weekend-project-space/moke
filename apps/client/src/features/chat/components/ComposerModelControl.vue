<script setup lang="ts">
import { Check, ChevronDown, ChevronRight, Cpu } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ModelSummary } from '@moke/agent-sdk'
import { uiText } from '../../../text/uiText'
import type { ReasoningEffort } from '../model/conversation'

type ComposerReasoningEffort = 'default' | ReasoningEffort
type ComposerModel = ModelSummary & { provider: string; providerName?: string }
type Submenu = 'model' | 'effort'

const props = defineProps<{
  open: boolean
  modelName: string
  modelProvider: string
  modelProviderId?: string
  models: ComposerModel[]
  reasoningEffort: ComposerReasoningEffort
  reasoningOptions: ReasoningEffort[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:reasoningEffort': [value: ComposerReasoningEffort]
  selectModel: [model: ComposerModel]
}>()

const controlEl = ref<HTMLElement | null>(null)
const rootMenuEl = ref<HTMLElement | null>(null)
const submenuEl = ref<HTMLElement | null>(null)
const activeSubmenu = ref<Submenu | null>(null)
const submenuSide = ref<'left' | 'right'>('right')
let closeTimer: ReturnType<typeof setTimeout> | undefined

const selectedModelKey = computed(() => `${props.modelProviderId || props.modelProvider}\u0000${props.modelName}`)
const selectedModelLabel = computed(() => props.models.find((model) => modelKey(model) === selectedModelKey.value)?.alias || props.modelName)
const modelsByProvider = computed(() => {
  const groups = new Map<string, { provider: string; label: string; models: ComposerModel[] }>()
  for (const model of props.models) {
    const group = groups.get(model.provider)
    if (group) group.models.push(model)
    else groups.set(model.provider, {
      provider: model.provider,
      label: model.providerName || model.provider,
      models: [model],
    })
  }
  return [...groups.values()]
})

function modelKey(model: ComposerModel) {
  return `${model.provider}\u0000${model.name}`
}

function reasoningLabel(value: ComposerReasoningEffort) {
  return value === 'default' ? uiText.composer.thinkingAuto : uiText.composer.thinkingOption(value)
}

function cancelSubmenuClose() {
  if (closeTimer !== undefined) clearTimeout(closeTimer)
  closeTimer = undefined
}

function scheduleSubmenuClose() {
  if (!activeSubmenu.value) return
  cancelSubmenuClose()
  closeTimer = setTimeout(() => {
    activeSubmenu.value = null
    closeTimer = undefined
  }, 160)
}

async function activateSubmenu(submenu: Submenu, event?: PointerEvent) {
  if (event?.pointerType === 'touch') return
  cancelSubmenuClose()
  activeSubmenu.value = submenu
  await nextTick()

  const rootRect = rootMenuEl.value?.getBoundingClientRect()
  const submenuWidth = submenuEl.value?.offsetWidth || 220
  if (!rootRect) return
  submenuSide.value = window.innerWidth - rootRect.right >= submenuWidth + 8 ? 'right' : 'left'
}

function toggle() {
  emit('update:open', !props.open)
}

function close() {
  emit('update:open', false)
}

function selectModel(model: ComposerModel) {
  emit('selectModel', model)
  close()
}

function selectReasoning(value: ComposerReasoningEffort) {
  emit('update:reasoningEffort', value)
  close()
}

function handleOutsidePointerDown(event: PointerEvent) {
  if (!props.open) return
  const target = event.target
  if (target instanceof Node && controlEl.value?.contains(target)) return
  close()
}

watch(() => props.open, (open) => {
  if (open) return
  cancelSubmenuClose()
  activeSubmenu.value = null
})

onMounted(() => document.addEventListener('pointerdown', handleOutsidePointerDown))
onUnmounted(() => {
  cancelSubmenuClose()
  document.removeEventListener('pointerdown', handleOutsidePointerDown)
})
</script>

<template>
  <div
    ref="controlEl"
    class="composer-model-control"
    @pointerenter="cancelSubmenuClose"
    @pointerleave="scheduleSubmenuClose"
    @keydown.esc.stop="close"
  >
    <div v-if="open" ref="rootMenuEl" class="composer-model-root-menu">
      <div class="composer-model-menu-surface" role="menu" aria-label="Model settings">
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          :aria-expanded="activeSubmenu === 'model'"
          :class="{ active: activeSubmenu === 'model' }"
          @click="activateSubmenu('model')"
          @pointerenter="activateSubmenu('model', $event)"
          @keydown.right.prevent="activateSubmenu('model')"
        >
          <span>Model</span>
          <span class="composer-model-menu-value">{{ selectedModelLabel || 'Select model' }}</span>
          <ChevronRight :size="15" stroke-width="2" />
        </button>
        <button
          v-if="reasoningOptions.length"
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          :aria-expanded="activeSubmenu === 'effort'"
          :class="{ active: activeSubmenu === 'effort' }"
          @click="activateSubmenu('effort')"
          @pointerenter="activateSubmenu('effort', $event)"
          @keydown.right.prevent="activateSubmenu('effort')"
        >
          <span>Effort</span>
          <span class="composer-model-menu-value">{{ reasoningLabel(reasoningEffort) }}</span>
          <ChevronRight :size="15" stroke-width="2" />
        </button>
      </div>

      <Transition name="composer-cascade-panel">
        <div
          v-if="activeSubmenu"
          :key="activeSubmenu"
          ref="submenuEl"
          class="composer-model-submenu composer-model-menu-surface"
          :class="`side-${submenuSide}`"
          role="menu"
          :aria-label="activeSubmenu === 'model' ? 'Choose model' : 'Choose effort'"
          @keydown.left.stop.prevent="activeSubmenu = null"
        >
          <template v-if="activeSubmenu === 'model'">
            <div class="composer-model-submenu-title">Model</div>
            <div v-for="group in modelsByProvider" :key="group.provider" class="composer-model-provider-group">
              <div class="composer-model-provider-label">{{ group.label }}</div>
              <button
                v-for="model in group.models"
                :key="modelKey(model)"
                type="button"
                role="menuitemradio"
                :aria-checked="modelKey(model) === selectedModelKey"
                :class="{ active: modelKey(model) === selectedModelKey }"
                @click="selectModel(model)"
              >
                <span>{{ model.alias || model.name }}</span>
                <Check v-if="modelKey(model) === selectedModelKey" :size="15" stroke-width="2.2" />
              </button>
            </div>
          </template>

          <template v-else>
            <div class="composer-model-submenu-title">Effort</div>
            <button
              type="button"
              role="menuitemradio"
              :aria-checked="reasoningEffort === 'default'"
              :class="{ active: reasoningEffort === 'default' }"
              @click="selectReasoning('default')"
            >
              <span>{{ reasoningLabel('default') }}</span>
              <Check v-if="reasoningEffort === 'default'" :size="15" stroke-width="2.2" />
            </button>
            <button
              v-for="option in reasoningOptions"
              :key="option"
              type="button"
              role="menuitemradio"
              :aria-checked="option === reasoningEffort"
              :class="{ active: option === reasoningEffort }"
              @click="selectReasoning(option)"
            >
              <span class="composer-effort-option-copy">
                <span>{{ reasoningLabel(option) }}</span>
                <small v-if="option === 'max'">Uses more tokens</small>
              </span>
              <Check v-if="option === reasoningEffort" :size="15" stroke-width="2.2" />
            </button>
          </template>
        </div>
      </Transition>
    </div>

    <button
      class="composer-model-action"
      type="button"
      :aria-label="uiText.composer.currentModel(modelName, modelProvider)"
      :title="uiText.composer.currentModel(modelName, modelProvider)"
      :aria-expanded="open"
      :class="{ active: open }"
      @click="toggle"
    >
      <Cpu :size="14" stroke-width="1.8" />
      <span class="composer-model-name">{{ selectedModelLabel || 'Select model' }}</span>
      <span v-if="reasoningOptions.length" class="composer-model-effort">{{ reasoningLabel(reasoningEffort) }}</span>
      <ChevronDown :size="12" stroke-width="2.1" />
    </button>
  </div>
</template>

<style scoped>
.composer-model-control {
  position: relative;
  flex: 0 0 auto;
}

.composer-model-root-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 20;
}

.composer-model-menu-surface {
  width: 230px;
  padding: 4px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-popover);
  box-shadow: var(--shadow-menu);
}

.composer-model-menu-surface button {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  background: transparent;
  box-shadow: none;
  font-size: var(--font-size-ui);
  text-align: left;
}

.composer-model-menu-surface button:hover,
.composer-model-menu-surface button:focus-visible,
.composer-model-menu-surface button.active {
  background: var(--color-secondary-hover);
}

.composer-model-control button:focus-visible {
  outline: 2px solid var(--color-border-strong);
  outline-offset: -2px;
}

.composer-model-root-menu > .composer-model-menu-surface > button > svg {
  flex: 0 0 auto;
  color: var(--color-text-muted);
}

.composer-model-menu-value {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-model-submenu {
  position: absolute;
  bottom: 0;
  width: 220px;
  max-height: min(360px, calc(100vh - 24px));
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.composer-model-submenu.side-right {
  left: calc(100% + 6px);
}

.composer-model-submenu.side-left {
  right: calc(100% + 6px);
}

.composer-model-submenu-title,
.composer-model-provider-label {
  padding: 6px 9px 3px;
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
  font-weight: 500;
}

.composer-model-provider-group + .composer-model-provider-group {
  margin-top: 4px;
}

.composer-model-submenu button > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-model-submenu button > svg {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--color-text-primary);
}

.composer-effort-option-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.composer-effort-option-copy small {
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
  font-weight: 400;
}

.composer-cascade-panel-enter-active,
.composer-cascade-panel-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}

.composer-cascade-panel-enter-from,
.composer-cascade-panel-leave-to {
  opacity: 0;
}

.composer-cascade-panel-enter-from.side-right,
.composer-cascade-panel-leave-to.side-right {
  transform: translateX(-4px);
}

.composer-cascade-panel-enter-from.side-left,
.composer-cascade-panel-leave-to.side-left {
  transform: translateX(4px);
}

@media (prefers-reduced-motion: reduce) {
  .composer-cascade-panel-enter-active,
  .composer-cascade-panel-leave-active {
    transition: none;
  }
}

@media (max-width: 520px) {
  .composer-model-menu-surface {
    width: min(230px, calc(100vw - 24px));
  }

  .composer-model-submenu.side-left,
  .composer-model-submenu.side-right {
    right: 0;
    bottom: calc(100% + 6px);
    left: auto;
    width: min(220px, calc(100vw - 24px));
  }
}
</style>
