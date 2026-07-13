<script setup lang="ts">
import { BrainCircuit, ChevronDown, ChevronRight, Code2, FilePenLine, FolderSearch, Terminal } from 'lucide-vue-next'
import type { ToolCategory, ProcessViewItem } from '../presentation/types'
import ToolStepDetails from './ToolStepDetails.vue'
import { uiText } from '../../../text/uiText'

const props = defineProps<{
  label: string
  durationLabel: string
  items: ProcessViewItem[]
  collapsed: boolean
  hasError: boolean
  isActive?: boolean
  renderMarkdown: (content: string) => string
}>()

const emit = defineEmits<{
  toggle: []
}>()


function iconKind(step: { toolCategory: ToolCategory }) {
  return step.toolCategory
}
</script>

<template>
  <div class="process-group" :class="{ active: isActive, error: hasError }">
    <button class="process-toggle" type="button" :aria-expanded="!collapsed" @click="emit('toggle')">
      <span v-if="isActive" class="process-active-indicator" aria-hidden="true"></span>
      <span class="process-toggle-label">
        <template v-if="isActive">
          <span class="process-active-label">{{ uiText.process.working }}</span>
          <span>{{ durationLabel }}</span>
        </template>
        <template v-else>{{ label }}</template>
      </span>
      <span class="process-caret" aria-hidden="true">
        <ChevronRight v-if="collapsed" :size="15" stroke-width="2" />
        <ChevronDown v-else :size="15" stroke-width="2" />
      </span>
    </button>
    <div v-if="!collapsed" class="process-list">
      <details
        v-for="processItem in items"
        :key="processItem.id"
        class="process-item"
        :open="processItem.kind === 'reasoning' && isActive"
        :class="[
          processItem.tone,
          processItem.kind,
          processItem.kind === 'tool-step' ? `category-${processItem.toolCategory}` : '',
        ]"
      >
        <summary v-if="processItem.kind === 'assistant'" class="process-assistant-summary">
          <div class="markdown" v-html="renderMarkdown(processItem.raw || processItem.detail)"></div>
        </summary>
        <summary v-else-if="processItem.kind === 'reasoning'" class="process-reasoning-summary">
          <span class="process-reasoning-icon" aria-hidden="true">
            <BrainCircuit :size="14" stroke-width="1.8" />
          </span>
          <span class="process-reasoning-title">{{ processItem.actionLabel || uiText.process.reasoning }}</span>
          <span class="process-step-caret" aria-hidden="true">
            <ChevronRight class="when-closed" :size="15" stroke-width="2" />
            <ChevronDown class="when-open" :size="15" stroke-width="2" />
          </span>
        </summary>
        <summary v-else-if="processItem.kind === 'tool-step'" class="process-tool-step-summary">
          <span class="process-tool-icon" aria-hidden="true">
            <FilePenLine v-if="iconKind(processItem) === 'change'" :size="14" stroke-width="1.9" />
            <FolderSearch v-else-if="iconKind(processItem) === 'view'" :size="14" stroke-width="1.9" />
            <Terminal v-else-if="iconKind(processItem) === 'run'" :size="14" stroke-width="1.9" />
            <Code2 v-else :size="14" stroke-width="1.9" />
          </span>
          <span class="process-tool-title">{{ processItem.actionLabel }}</span>
          <span v-if="processItem.tone === 'error'" class="process-tool-status">{{ uiText.process.failed }}</span>
          <span v-if="processItem.objectLabel" class="process-tool-separator" aria-hidden="true">·</span>
          <small v-if="processItem.objectLabel" class="process-tool-detail">{{ processItem.objectLabel }}</small>
          <span class="process-step-caret" aria-hidden="true">
            <ChevronRight class="when-closed" :size="15" stroke-width="2" />
            <ChevronDown class="when-open" :size="15" stroke-width="2" />
          </span>
        </summary>
        <summary v-else>
          <span class="process-tool-title">{{ processItem.actionLabel || processItem.title }}</span>
          <small class="process-tool-detail">{{ processItem.objectLabel || processItem.detail }}</small>
        </summary>
        <ToolStepDetails v-if="processItem.kind === 'tool-step'" :step="processItem" />
        <div v-else-if="processItem.kind === 'reasoning' && processItem.raw" class="process-reasoning-body">{{ processItem.raw }}</div>
        <pre v-else-if="processItem.raw && processItem.kind !== 'assistant'">{{ processItem.raw }}</pre>
      </details>
    </div>
  </div>
</template>
