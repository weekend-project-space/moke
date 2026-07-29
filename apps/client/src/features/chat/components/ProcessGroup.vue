<script setup lang="ts">
import { Check, CircleX, ChevronDown, ChevronRight, Code2, FilePenLine, Plug, Search, Send, ShieldCheck, ShieldX, Sparkles, SquareDashedMousePointer, SquareTerminal } from 'lucide-vue-next'
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
  showResultDivider?: boolean
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
    <div v-if="showResultDivider" class="process-result-divider" aria-hidden="true"></div>
    <div v-if="!collapsed" class="process-list">
      <template v-for="processItem in items" :key="processItem.id">
        <div
          v-if="processItem.kind === 'tool-step' && processItem.renderer === 'ask-user'"
          class="process-item tool-step category-run"
        >
          <div class="process-ask-summary">
            <span class="process-ask-icon" aria-hidden="true">
              <Check :size="14" stroke-width="2" />
            </span>
            <span class="process-ask-label">{{ uiText.tool.userInput }}</span>
            <span class="process-tool-separator" aria-hidden="true">·</span>
            <small class="process-ask-question" :title="processItem.summary.question || processItem.objectLabel">
              {{ processItem.summary.question || processItem.objectLabel }}
            </small>
            <span
              v-if="processItem.state?.kind === 'failed' || processItem.summary.selectedLabel"
              class="process-ask-selection"
              :class="processItem.state?.kind"
              :title="processItem.state?.label || processItem.summary.selectedLabel"
            >
              <span class="process-ask-answer-separator" aria-hidden="true">→</span>
              <span class="process-ask-answer">{{ processItem.state?.label || processItem.summary.selectedLabel }}</span>
            </span>
          </div>
        </div>
      <details
        v-else
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
            <Sparkles :size="14" stroke-width="1.8" />
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
            <Search v-else-if="iconKind(processItem) === 'view'" :size="14" stroke-width="1.9" />
            <SquareTerminal v-else-if="iconKind(processItem) === 'run'" :size="14" stroke-width="1.9" />
            <SquareDashedMousePointer v-else-if="iconKind(processItem) === 'browser'" :size="14" stroke-width="1.9" />
            <Send v-else-if="iconKind(processItem) === 'claw'" :size="14" stroke-width="1.9" />
            <Plug v-else-if="iconKind(processItem) === 'skill'" :size="14" stroke-width="1.9" />
            <Code2 v-else :size="14" stroke-width="1.9" />
          </span>
          <span class="process-tool-title">{{ processItem.toolName }}</span>
          <span v-if="processItem.objectLabel" class="process-tool-separator" aria-hidden="true">·</span>
          <small v-if="processItem.objectLabel" class="process-tool-detail">{{ processItem.objectLabel }}</small>
          <span
            v-if="processItem.state"
            class="process-tool-state"
            :class="processItem.state.kind"
            :title="processItem.state.label"
          >
            <ShieldCheck v-if="processItem.state.kind === 'approved'" :size="13" stroke-width="1.9" />
            <ShieldX v-else-if="processItem.state.kind === 'rejected'" :size="13" stroke-width="1.9" />
            <CircleX v-else :size="13" stroke-width="1.9" />
            <span>{{ processItem.state.label }}</span>
          </span>
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
      </template>
    </div>
  </div>
</template>
