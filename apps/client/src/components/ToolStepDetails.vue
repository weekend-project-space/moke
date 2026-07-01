<script setup lang="ts">
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { computed } from 'vue'
import type { ToolStepViewItem } from '../types/conversation'
import { formatBytes, guardToolContent } from '../composables/toolContentGuard'

const props = defineProps<{
  step: ToolStepViewItem
}>()

const doneText = '\u5df2\u5b8c\u6210'
const resultItems = computed(() => props.step.summary.files || [])
const guardedResultItems = computed(() => guardToolContent(resultItems.value.join('\n')))
const hasRawData = computed(() => Boolean(props.step.inputRaw || props.step.outputRaw))
const outputText = computed(() => props.step.outputRaw || '\u7b49\u5f85\u7ed3\u679c')
const commandOutput = computed(() => props.step.summary.stdout || props.step.summary.stderr || '\u547d\u4ee4\u65e0\u8f93\u51fa')
const guardedCommandOutput = computed(() => guardToolContent(commandOutput.value))
const commandStatusText = computed(() => (props.step.tone === 'error' ? '\u5931\u8d25' : '\u6210\u529f'))
const commandExitCode = computed(() =>
  typeof props.step.summary.exitCode === 'number' ? props.step.summary.exitCode : props.step.tone === 'error' ? 1 : 0,
)
const isCommandError = computed(() => props.step.tone === 'error' || Boolean(props.step.summary.stderr && !props.step.summary.stdout))
const genericText = computed(() => props.step.summary.preview || (props.step.outputRaw ? '' : '\u7b49\u5f85\u7ed3\u679c'))
const browserText = computed(() => props.step.summary.preview || browserFallbackText(props.step.toolName))
const fileChangeText = computed(() => props.step.summary.preview || doneText)
const guardedGenericText = computed(() => guardToolContent(genericText.value))
const guardedBrowserText = computed(() => guardToolContent(browserText.value))
const guardedFileChangeText = computed(() => guardToolContent(fileChangeText.value))
const guardedFileReadText = computed(() => guardToolContent(props.step.summary.preview || ''))
const guardedInputRaw = computed(() => guardToolContent(props.step.inputRaw || ''))
const guardedOutputRaw = computed(() => guardToolContent(outputText.value))
const resultCount = computed(() => props.step.summary.count ?? resultItems.value.length)
const resultUnit = computed(() => (props.step.renderer === 'directory' ? '\u9879' : '\u6761'))
const resultStatusText = computed(() => (props.step.tone === 'error' ? '\u5931\u8d25' : '\u6210\u529f'))
const resultEmptyText = computed(() => {
  if (props.step.tone === 'error') return props.step.summary.preview || (props.step.renderer === 'directory' ? '\u8bfb\u53d6\u76ee\u5f55\u5931\u8d25' : '\u641c\u7d22\u5931\u8d25')
  return props.step.renderer === 'directory' ? '\u76ee\u5f55\u4e3a\u7a7a' : '\u6ca1\u6709\u627e\u5230\u76f8\u5173\u7ed3\u679c'
})

function browserFallbackText(toolName: string) {
  if (toolName === 'navigate_page' || toolName === 'create_page' || toolName === 'select_page') return '\u9875\u9762\u5df2\u6253\u5f00'
  if (toolName === 'click') return '\u70b9\u51fb\u5b8c\u6210'
  if (toolName === 'fill' || toolName === 'fill_form' || toolName === 'type_text') return '\u586b\u5199\u5b8c\u6210'
  if (toolName === 'take_snapshot') return '\u5df2\u8bfb\u53d6\u9875\u9762\u7ed3\u6784'
  if (toolName === 'take_screenshot') return '\u5df2\u622a\u53d6\u9875\u9762'
  if (toolName === 'wait_for') return '\u5df2\u7b49\u5230\u76ee\u6807\u72b6\u6001'
  return doneText
}
</script>

<template>
  <div class="tool-detail">
    <template v-if="step.renderer === 'search' || step.renderer === 'directory'">
      <div class="tool-result-console" :class="{ error: step.tone === 'error' }">
        <div class="tool-result-lines">
          <div v-if="guardedResultItems.isOversize" class="tool-content-oversize">
            Content is {{ formatBytes(guardedResultItems.bytes) }}. It is larger than 100 kB and is not rendered inline.
          </div>
          <template v-else-if="resultItems.length">
            <div v-for="item in resultItems" :key="item" class="tool-result-line">{{ item }}</div>
          </template>
          <div v-else class="tool-result-empty">{{ resultEmptyText }}</div>
        </div>
        <div class="tool-result-footer">
          <span>{{ resultCount }} {{ resultUnit }}</span>
          <span>{{ resultStatusText }}</span>
        </div>
      </div>
    </template>

    <template v-else-if="step.renderer === 'command'">
      <div class="tool-command-card" :class="{ error: isCommandError }">
        <div class="tool-command-header">
          <span>Shell</span>
        </div>
        <div class="tool-command-body">
          <div class="tool-command-prompt">
            <span class="tool-command-symbol">$</span>
            <span class="tool-command-text">{{ step.summary.command || step.objectLabel }}</span>
          </div>
          <div v-if="guardedCommandOutput.isOversize" class="tool-content-oversize">
            Content is {{ formatBytes(guardedCommandOutput.bytes) }}. It is larger than 100 kB and is not rendered inline.
          </div>
          <div v-else class="tool-command-output" :class="{ error: isCommandError }">{{ guardedCommandOutput.text }}</div>
        </div>
        <div class="tool-command-footer">
          <span>Exit {{ commandExitCode }}</span>
          <span>{{ commandStatusText }}</span>
        </div>
      </div>
    </template>

    <template v-else-if="step.renderer === 'file-read'">
      <p v-if="guardedFileReadText.isOversize" class="tool-content-oversize">
        Content is {{ formatBytes(guardedFileReadText.bytes) }}. It is larger than 100 kB and is not rendered inline.
      </p>
      <pre v-else-if="guardedFileReadText.text" class="tool-detail-output">{{ guardedFileReadText.text }}</pre>
      <p v-else class="tool-detail-note">读取内容为空</p>
    </template>

    <template v-else-if="step.renderer === 'file-change'">
      <p v-if="fileChangeText === doneText" class="tool-detail-note">{{ fileChangeText }}</p>
      <p v-else-if="guardedFileChangeText.isOversize" class="tool-content-oversize">
        Content is {{ formatBytes(guardedFileChangeText.bytes) }}. It is larger than 100 kB and is not rendered inline.
      </p>
      <pre v-else class="tool-detail-output">{{ guardedFileChangeText.text }}</pre>
    </template>

    <template v-else-if="step.renderer === 'browser'">
      <p v-if="guardedBrowserText.isOversize" class="tool-content-oversize">
        Content is {{ formatBytes(guardedBrowserText.bytes) }}. It is larger than 100 kB and is not rendered inline.
      </p>
      <pre v-else class="tool-detail-output compact">{{ guardedBrowserText.text }}</pre>
    </template>

    <template v-else>
      <p v-if="guardedGenericText.isOversize" class="tool-content-oversize">
        Content is {{ formatBytes(guardedGenericText.bytes) }}. It is larger than 100 kB and is not rendered inline.
      </p>
      <pre v-else-if="guardedGenericText.text && guardedGenericText.text !== doneText" class="tool-detail-output">{{ guardedGenericText.text }}</pre>
      <p v-else class="tool-detail-note">{{ genericText || doneText }}</p>
    </template>

    <details v-if="hasRawData" class="tool-detail-raw">
      <summary>
        <span class="tool-detail-raw-caret" aria-hidden="true">
          <ChevronRight class="when-closed" :size="12" stroke-width="2" />
          <ChevronDown class="when-open" :size="12" stroke-width="2" />
        </span>
        <span>JSON</span>
      </summary>
      <div class="tool-detail-raw-grid">
        <div v-if="step.inputRaw" class="process-json-block">
          <span>输入</span>
          <p v-if="guardedInputRaw.isOversize" class="tool-content-oversize">
            Content is {{ formatBytes(guardedInputRaw.bytes) }}. It is larger than 100 kB and is not rendered inline.
          </p>
          <pre v-else>{{ guardedInputRaw.text }}</pre>
        </div>
        <div class="process-json-block">
          <span>输出</span>
          <p v-if="guardedOutputRaw.isOversize" class="tool-content-oversize">
            Content is {{ formatBytes(guardedOutputRaw.bytes) }}. It is larger than 100 kB and is not rendered inline.
          </p>
          <pre v-else>{{ guardedOutputRaw.text }}</pre>
        </div>
      </div>
    </details>
  </div>
</template>
