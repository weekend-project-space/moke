<script setup lang="ts">
import { Check, ChevronDown } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ModelSummary } from '@moke/agent-sdk'
import { uiText } from '../../../text/uiText'
import type { ReasoningEffort } from '../model/conversation'

type ComposerReasoningEffort = 'default' | ReasoningEffort
type ComposerModel = ModelSummary & { provider: string; providerName?: string }
type MenuSection = 'model' | 'effort'

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
const expandedSection = ref<MenuSection | null>('model')

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

function toggleSection(section: MenuSection) {
  expandedSection.value = expandedSection.value === section ? null : section
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

watch(() => props.open, async (open) => {
  if (!open) return
  expandedSection.value = 'model'
  await nextTick()
  rootMenuEl.value
    ?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
    ?.scrollIntoView({ block: 'nearest' })
})

onMounted(() => document.addEventListener('pointerdown', handleOutsidePointerDown))
onUnmounted(() => document.removeEventListener('pointerdown', handleOutsidePointerDown))
</script>

<template>
  <div
    ref="controlEl"
    class="composer-model-control"
    @keydown.esc.stop="close"
  >
    <div
      v-if="open"
      ref="rootMenuEl"
      class="composer-model-root-menu"
      role="menu"
      aria-label="Model settings"
    >
        <div class="composer-model-section" :class="{ expanded: expandedSection === 'model' }">
          <button
            class="composer-model-section-trigger"
            type="button"
            role="menuitem"
            :aria-expanded="expandedSection === 'model'"
            @click="toggleSection('model')"
          >
            <span class="composer-model-section-label">Model</span>
            <span class="composer-model-menu-value">{{ selectedModelLabel || 'Select model' }}</span>
            <ChevronDown class="composer-model-section-chevron" :size="14" stroke-width="2" />
          </button>

          <div v-if="expandedSection === 'model'" class="composer-model-section-body" role="group" aria-label="Choose model">
            <div v-for="group in modelsByProvider" :key="group.provider" class="composer-model-provider-group">
              <div class="composer-model-provider-label">{{ group.label }}</div>
              <button
                v-for="model in group.models"
                :key="modelKey(model)"
                class="composer-model-option"
                type="button"
                role="menuitemradio"
                :aria-checked="modelKey(model) === selectedModelKey"
                @click="selectModel(model)"
              >
                <span>{{ model.alias || model.name }}</span>
                <Check v-if="modelKey(model) === selectedModelKey" :size="15" stroke-width="2.2" />
              </button>
            </div>
          </div>
        </div>

        <div
          v-if="reasoningOptions.length"
          class="composer-model-section"
          :class="{ expanded: expandedSection === 'effort' }"
        >
          <button
            class="composer-model-section-trigger"
            type="button"
            role="menuitem"
            :aria-expanded="expandedSection === 'effort'"
            @click="toggleSection('effort')"
          >
            <span class="composer-model-section-label">Effort</span>
            <span class="composer-model-menu-value">{{ reasoningLabel(reasoningEffort) }}</span>
            <ChevronDown class="composer-model-section-chevron" :size="14" stroke-width="2" />
          </button>

          <div v-if="expandedSection === 'effort'" class="composer-model-section-body" role="group" aria-label="Choose effort">
            <button
              class="composer-model-option"
              type="button"
              role="menuitemradio"
              :aria-checked="reasoningEffort === 'default'"
              @click="selectReasoning('default')"
            >
              <span>{{ reasoningLabel('default') }}</span>
              <Check v-if="reasoningEffort === 'default'" :size="15" stroke-width="2.2" />
            </button>
            <button
              v-for="option in reasoningOptions"
              :key="option"
              class="composer-model-option"
              type="button"
              role="menuitemradio"
              :aria-checked="option === reasoningEffort"
              @click="selectReasoning(option)"
            >
              <span>{{ reasoningLabel(option) }}</span>
              <Check v-if="option === reasoningEffort" :size="15" stroke-width="2.2" />
            </button>
          </div>
        </div>
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
  display: flex;
  width: min(268px, calc(100vw - 24px));
  max-height: min(368px, calc(100vh - 24px));
  flex-direction: column;
  padding: 5px;
  overflow: hidden;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-popover);
  box-shadow: var(--shadow-menu);
}

.composer-model-root-menu button {
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  background: transparent;
  box-shadow: none;
  text-align: left;
}

.composer-model-root-menu button:hover,
.composer-model-root-menu button:focus-visible,
.composer-model-root-menu .composer-model-option[aria-checked='true'] {
  background: var(--color-secondary-hover);
}

.composer-model-control button:focus-visible {
  outline: 2px solid var(--color-border-strong);
  outline-offset: -2px;
}

.composer-model-section {
  display: flex;
  min-height: 0;
  flex: 0 0 auto;
  flex-direction: column;
}

.composer-model-section.expanded {
  flex: 1 1 auto;
}

.composer-model-section + .composer-model-section {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--color-border-subtle);
}

.composer-model-root-menu .composer-model-section-trigger {
  display: grid;
  min-height: 32px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 0 9px;
}

.composer-model-section-label {
  font-size: var(--font-size-meta);
  font-weight: 400;
}

.composer-model-menu-value {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-model-section-chevron {
  color: var(--color-text-muted);
  transition: transform 140ms ease;
}

.composer-model-section-trigger[aria-expanded='true'] .composer-model-section-chevron {
  transform: rotate(180deg);
}

.composer-model-section-body {
  min-height: 0;
  flex: 1 1 auto;
  padding: 2px 0 8px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: var(--color-text-muted) transparent;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  animation: composer-disclosure-in 120ms ease-out;
}

.composer-model-section-body::-webkit-scrollbar {
  width: 8px;
}

.composer-model-section-body::-webkit-scrollbar-track {
  background: transparent;
}

.composer-model-section-body::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: var(--radius-pill);
  background: var(--color-text-muted);
  background-clip: padding-box;
}

.composer-model-section-body::-webkit-scrollbar-button {
  display: none;
}

.composer-model-provider-label {
  padding: 7px 10px 3px;
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
  font-weight: 500;
}

.composer-model-provider-group + .composer-model-provider-group {
  margin-top: 3px;
}

.composer-model-root-menu .composer-model-option {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 6px 10px;
  font-size: var(--font-size-meta);
}

.composer-model-option > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-model-option > svg {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--color-text-secondary);
}

@keyframes composer-disclosure-in {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer-model-section-chevron {
    transition: none;
  }

  .composer-model-section-body {
    animation: none;
  }
}

@media (max-width: 520px) {
  .composer-model-root-menu {
    max-height: min(280px, calc(100vh - 24px));
  }
}
</style>
