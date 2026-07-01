<script setup lang="ts">
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { computed } from 'vue'
import type { ToolStepViewItem } from '../types/conversation'

const props = defineProps<{
  step: ToolStepViewItem
}>()

const doneText = '\u5df2\u5b8c\u6210'
const resultItems = computed(() => props.step.summary.files || [])
const hasRawData = computed(() => Boolean(props.step.inputRaw || props.step.outputRaw))
const outputText = computed(() => props.step.outputRaw || '\u7b49\u5f85\u7ed3\u679c')
const commandOutput = computed(() => props.step.summary.stdout || props.step.summary.stderr || '\u547d\u4ee4\u65e0\u8f93\u51fa')
const commandStatusText = computed(() => (props.step.tone === 'error' ? '\u5931\u8d25' : '\u6210\u529f'))
const commandExitCode = computed(() =>
  typeof props.step.summary.exitCode === 'number' ? props.step.summary.exitCode : props.step.tone === 'error' ? 1 : 0,
)
const isCommandError = computed(() => props.step.tone === 'error' || Boolean(props.step.summary.stderr && !props.step.summary.stdout))
const genericText = computed(() => props.step.summary.preview || (props.step.outputRaw ? '' : '\u7b49\u5f85\u7ed3\u679c'))
const browserText = computed(() => props.step.summary.preview || browserFallbackText(props.step.toolName))
const fileChangeText = computed(() => props.step.summary.preview || doneText)
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
          <template v-if="resultItems.length">
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
      <div class="tool-result-console command" :class="{ error: isCommandError }">
        <div class="tool-command-prompt">&gt; {{ step.summary.command || step.objectLabel }}</div>
        <pre class="tool-command-output" :class="{ error: isCommandError }">{{ commandOutput }}</pre>
        <div class="tool-result-footer">
          <span>退出码 {{ commandExitCode }}</span>
          <span>{{ commandStatusText }}</span>
        </div>
      </div>
    </template>

    <template v-else-if="step.renderer === 'file-read'">
      <pre v-if="step.summary.preview" class="tool-detail-output">{{ step.summary.preview }}</pre>
      <p v-else class="tool-detail-note">读取内容为空</p>
    </template>

    <template v-else-if="step.renderer === 'file-change'">
      <p v-if="fileChangeText === doneText" class="tool-detail-note">{{ fileChangeText }}</p>
      <pre v-else class="tool-detail-output">{{ fileChangeText }}</pre>
    </template>

    <template v-else-if="step.renderer === 'browser'">
      <p class="tool-detail-note">{{ browserText }}</p>
    </template>

    <template v-else>
      <pre v-if="genericText && genericText !== doneText" class="tool-detail-output">{{ genericText }}</pre>
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
          <pre>{{ step.inputRaw }}</pre>
        </div>
        <div class="process-json-block">
          <span>输出</span>
          <pre>{{ outputText }}</pre>
        </div>
      </div>
    </details>
  </div>
</template>
