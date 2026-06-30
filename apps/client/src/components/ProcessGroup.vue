<script setup lang="ts">
import { ChevronDown, ChevronRight, Code2, FilePenLine, FolderSearch, Terminal } from 'lucide-vue-next'
import type { ToolCategory, ToolRisk, ProcessViewItem } from '../types/conversation'

defineProps<{
  label: string
  items: ProcessViewItem[]
  collapsed: boolean
  hasError: boolean
  renderMarkdown: (content: string) => string
}>()

const emit = defineEmits<{
  toggle: []
}>()


function iconKind(step: { toolCategory: ToolCategory; toolRisk: ToolRisk }) {
  if (step.toolCategory === 'change' || step.toolRisk === 'write') return 'change'
  return step.toolCategory
}
</script>

<template>
  <div class="process-group" :class="{ error: hasError }">
    <button class="process-toggle" type="button" :aria-expanded="!collapsed" @click="emit('toggle')">
      <span class="process-caret" aria-hidden="true">
        <ChevronRight v-if="collapsed" :size="13" stroke-width="2" />
        <ChevronDown v-else :size="13" stroke-width="2" />
      </span>
      <span class="process-toggle-label">{{ label }}</span>
    </button>
    <div v-if="!collapsed" class="process-list">
      <details
        v-for="processItem in items"
        :key="processItem.id"
        class="process-item"
        :class="[
          processItem.tone,
          processItem.kind,
          processItem.kind === 'tool-step' || processItem.kind === 'tool-batch' ? `category-${processItem.toolCategory}` : '',
        ]"
      >
        <summary v-if="processItem.kind === 'assistant'" class="process-assistant-summary">
          <div class="markdown" v-html="renderMarkdown(processItem.raw || processItem.detail)"></div>
        </summary>
        <summary v-else-if="processItem.kind === 'tool-step' || processItem.kind === 'tool-batch'" class="process-tool-step-summary">
          <span class="process-tool-icon" aria-hidden="true">
            <FilePenLine v-if="iconKind(processItem) === 'change'" :size="14" stroke-width="1.9" />
            <FolderSearch v-else-if="iconKind(processItem) === 'view'" :size="14" stroke-width="1.9" />
            <Terminal v-else-if="iconKind(processItem) === 'run'" :size="14" stroke-width="1.9" />
            <Code2 v-else :size="14" stroke-width="1.9" />
          </span>
          <span class="process-tool-title">
            {{ processItem.kind === 'tool-batch' ? `${processItem.actionLabel} · ${processItem.countLabel}` : processItem.actionLabel }}
          </span>
          <span v-if="processItem.tone === 'error'" class="process-tool-status">失败</span>
          <span v-if="processItem.objectLabel" class="process-tool-separator" aria-hidden="true">·</span>
          <small v-if="processItem.objectLabel" class="process-tool-detail">{{ processItem.objectLabel }}</small>
        </summary>
        <summary v-else>
          <span class="process-tool-title">{{ processItem.actionLabel || processItem.title }}</span>
          <small class="process-tool-detail">{{ processItem.objectLabel || processItem.detail }}</small>
        </summary>
        <div v-if="processItem.kind === 'tool-step'" class="process-tool-jsons">
          <div class="process-tool-meta">
            <span>方法名</span>
            <code>{{ processItem.toolName }}</code>
          </div>
          <div v-if="processItem.inputRaw" class="process-json-block">
            <span>请求参数</span>
            <pre>{{ processItem.inputRaw }}</pre>
          </div>
          <div class="process-json-block">
            <span>响应结果</span>
            <pre>{{ processItem.outputRaw || '等待返回' }}</pre>
          </div>
        </div>
        <div v-else-if="processItem.kind === 'tool-batch'" class="process-batch-list">
          <details
            v-for="step in processItem.steps"
            :key="step.id"
            class="process-batch-step"
            :class="step.tone"
          >
            <summary>
              <span class="process-batch-dot" aria-hidden="true"></span>
              <span class="process-batch-title">{{ step.objectLabel }}</span>
            </summary>
            <div class="process-tool-jsons">
              <div class="process-tool-meta">
                <span>方法名</span>
                <code>{{ step.toolName }}</code>
              </div>
              <div v-if="step.inputRaw" class="process-json-block">
                <span>请求参数</span>
                <pre>{{ step.inputRaw }}</pre>
              </div>
              <div class="process-json-block">
                <span>响应结果</span>
                <pre>{{ step.outputRaw || '等待返回' }}</pre>
              </div>
            </div>
          </details>
        </div>
        <pre v-else-if="processItem.raw && processItem.kind !== 'assistant'">{{ processItem.raw }}</pre>
      </details>
    </div>
  </div>
</template>
