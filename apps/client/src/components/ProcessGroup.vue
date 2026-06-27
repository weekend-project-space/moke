<script setup lang="ts">
import { ChevronDown, ChevronRight, Code2, FolderSearch, Globe, ShieldAlert, Sparkles, Terminal } from 'lucide-vue-next'
import type { ProcessViewItem } from '../types/conversation'

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

function riskLabel(risk: string) {
  if (risk === 'dangerous') return '高风险'
  if (risk === 'write') return '写入'
  return '安全'
}
</script>

<template>
  <div class="process-group" :class="{ error: hasError }">
    <button class="process-toggle" type="button" :aria-expanded="!collapsed" @click="emit('toggle')">
      <span class="process-caret" aria-hidden="true">
        <ChevronRight v-if="collapsed" :size="13" stroke-width="2" />
        <ChevronDown v-else :size="13" stroke-width="2" />
      </span>
      <span>{{ label }}</span>
    </button>
    <div v-if="!collapsed" class="process-list">
      <details
        v-for="processItem in items"
        :key="processItem.id"
        class="process-item"
        :class="[
          processItem.tone,
          processItem.kind,
          processItem.kind === 'tool-step' ? `category-${processItem.toolCategory}` : '',
          processItem.kind === 'tool-step' ? `risk-${processItem.toolRisk}` : '',
        ]"
      >
        <summary v-if="processItem.kind === 'assistant'" class="process-assistant-summary">
          <div class="markdown" v-html="renderMarkdown(processItem.raw || processItem.detail)"></div>
        </summary>
        <summary v-else-if="processItem.kind === 'tool-step'" class="process-tool-step-summary">
          <span class="process-tool-icon" aria-hidden="true">
            <Globe v-if="processItem.toolCategory === 'browser'" :size="14" stroke-width="1.9" />
            <FolderSearch v-else-if="processItem.toolCategory === 'workspace'" :size="14" stroke-width="1.9" />
            <Sparkles v-else-if="processItem.toolCategory === 'skill'" :size="14" stroke-width="1.9" />
            <Terminal v-else-if="processItem.toolCategory === 'command'" :size="14" stroke-width="1.9" />
            <Code2 v-else :size="14" stroke-width="1.9" />
          </span>
          <span class="process-tool-title">{{ processItem.actionLabel }}</span>
          <span class="process-tool-separator" aria-hidden="true">·</span>
          <small class="process-tool-detail">{{ processItem.objectLabel }}</small>
        </summary>
        <summary v-else>
          <span class="process-tool-title">{{ processItem.actionLabel || processItem.title }}</span>
          <small class="process-tool-detail">{{ processItem.objectLabel || processItem.detail }}</small>
        </summary>
        <div v-if="processItem.kind === 'tool-step'" class="process-tool-jsons">
          <div class="process-tool-meta">
            <span>方法名</span>
            <code>{{ processItem.toolName }}</code>
            <span>{{ riskLabel(processItem.toolRisk) }}</span>
            <ShieldAlert v-if="processItem.toolRisk === 'dangerous'" :size="13" stroke-width="1.9" aria-hidden="true" />
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
        <pre v-else-if="processItem.raw && processItem.kind !== 'assistant'">{{ processItem.raw }}</pre>
      </details>
    </div>
  </div>
</template>
