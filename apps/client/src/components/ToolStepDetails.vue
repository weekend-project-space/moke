<script setup lang="ts">
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { computed } from 'vue'
import type { ToolStepViewItem } from '../types/conversation'
import { formatBytes, guardToolContent } from '../composables/toolContentGuard'
import { createCliTextResultView, createFileChangeResultView } from '../composables/toolResultView'
import { uiText } from '../text/uiText'

const props = defineProps<{
  step: ToolStepViewItem
}>()

const doneText = uiText.process.done
const emptyFileReadText = uiText.process.readEmpty
const jsonInputLabel = uiText.tool.input
const jsonOutputLabel = uiText.process.output
const resultItems = computed(() => props.step.summary.files || [])
const guardedResultItems = computed(() => guardToolContent(resultItems.value.join('\n')))
const hasRawData = computed(() => Boolean(props.step.inputRaw || props.step.outputRaw))
const outputText = computed(() => props.step.outputRaw || uiText.tool.waitingForResult)
const commandOutput = computed(() => props.step.summary.stdout || props.step.summary.stderr || uiText.tool.commandNoOutput)
const guardedCommandOutput = computed(() => guardToolContent(commandOutput.value))
const commandStatusText = computed(() => (props.step.tone === 'error' ? uiText.process.failed : uiText.process.success))
const commandExitCode = computed(() =>
  typeof props.step.summary.exitCode === 'number' ? props.step.summary.exitCode : props.step.tone === 'error' ? 1 : 0,
)
const isCommandError = computed(() => props.step.tone === 'error' || Boolean(props.step.summary.stderr && !props.step.summary.stdout))
const browserText = computed(() => props.step.summary.preview || browserFallbackText(props.step.toolName))
const guardedBrowserText = computed(() => guardToolContent(browserText.value))
const guardedFileReadText = computed(() => guardToolContent(props.step.summary.preview || ''))
const guardedInputRaw = computed(() => guardToolContent(props.step.inputRaw || ''))
const guardedOutputRaw = computed(() => guardToolContent(outputText.value))
const fileChangeView = computed(() => createFileChangeResultView(props.step))
const cliTextView = computed(() => createCliTextResultView(props.step))
const guardedFileChangeContent = computed(() => guardToolContent(fileChangeView.value.contentText))
const fileChangeLines = computed(() => guardedFileChangeContent.value.text.split('\n'))
const isDiffFileChange = computed(() => props.step.toolName === 'edit_file')
const fileHeaderPath = computed(() => fileChangeView.value.path || props.step.summary.path || props.step.objectLabel)
const fileHeaderName = computed(() => fileName(fileHeaderPath.value))
const fileHeaderStats = computed(() => {
  if (isDiffFileChange.value) return diffStats(fileChangeLines.value)
  if (props.step.renderer === 'file-change') return fileChangeView.value.metaItems.join(' ')
  return ''
})
const guardedCliText = computed(() => guardToolContent(cliTextView.value.text))
const resultCount = computed(() => props.step.summary.count ?? resultItems.value.length)
const resultUnit = computed(() => (props.step.renderer === 'directory' ? 'items' : 'matches'))
const resultStatusText = computed(() => (props.step.tone === 'error' ? uiText.process.failed : uiText.process.success))
const resultEmptyText = computed(() => {
  if (props.step.tone === 'error') {
    return props.step.summary.preview || (props.step.renderer === 'directory' ? uiText.tool.failedToReadDirectory : uiText.process.searchFailed)
  }

  return props.step.renderer === 'directory' ? uiText.process.emptyDirectory : uiText.process.noResults
})

function browserFallbackText(toolName: string) {
  if (toolName === 'navigate_page' || toolName === 'create_page' || toolName === 'select_page') return uiText.tool.pageOpened
  if (toolName === 'click') return uiText.tool.clickCompleted
  if (toolName === 'fill' || toolName === 'fill_form' || toolName === 'type_text') return uiText.tool.inputCompleted
  if (toolName === 'take_snapshot') return uiText.tool.pageStructureCaptured
  if (toolName === 'take_screenshot') return uiText.tool.screenshotCaptured
  if (toolName === 'wait_for') return uiText.tool.targetStateReached
  return doneText
}

function fileChangeLineText(line: string) {
  if (!isDiffFileChange.value) return line
  if (line.startsWith('- ') || line.startsWith('+ ')) return line.slice(2)
  return line
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path || props.step.toolName
}

function diffStats(lines: string[]) {
  const added = lines.filter((line) => line.startsWith('+ ')).length
  const removed = lines.filter((line) => line.startsWith('- ')).length
  const parts: string[] = []

  if (added) parts.push(`+${added}`)
  if (removed) parts.push(`-${removed}`)

  return parts.join(' ')
}
</script>

<template>
  <div class="tool-detail">
    <template v-if="step.renderer === 'search' || step.renderer === 'directory'">
      <div class="tool-panel-card tool-result-console" :class="{ error: step.tone === 'error' }">
        <div class="tool-panel-header">
          <span>{{ step.summary.path || step.summary.query || step.objectLabel || step.actionLabel }}</span>
        </div>
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
      <div class="tool-panel-card tool-command-card" :class="{ error: isCommandError }">
        <div class="tool-panel-header">
          <span>{{ uiText.process.shell }}</span>
          <strong>{{ uiText.process.exit }} {{ commandExitCode }}</strong>
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
          <span>{{ commandStatusText }}</span>
        </div>
      </div>
    </template>

    <template v-else-if="step.renderer === 'file-read'">
      <div class="tool-panel-card">
        <div class="tool-panel-header">
          <span>{{ fileHeaderName }}</span>
        </div>
        <p v-if="guardedFileReadText.isOversize" class="tool-content-oversize">
          Content is {{ formatBytes(guardedFileReadText.bytes) }}. It is larger than 100 kB and is not rendered inline.
        </p>
        <pre v-else-if="guardedFileReadText.text" class="tool-detail-output">{{ guardedFileReadText.text }}</pre>
        <p v-else class="tool-detail-note">{{ emptyFileReadText }}</p>
      </div>
    </template>

    <template v-else-if="step.renderer === 'file-change'">
      <div class="tool-panel-card">
        <div class="tool-panel-header">
          <span>{{ fileHeaderName }}</span>
          <strong v-if="fileHeaderStats">{{ fileHeaderStats }}</strong>
        </div>
        <p v-if="guardedFileChangeContent.isOversize" class="tool-content-oversize">
          Content is {{ formatBytes(guardedFileChangeContent.bytes) }}. It is larger than 100 kB and is not rendered inline.
        </p>
        <div v-else-if="guardedFileChangeContent.text" class="tool-file-change-content">
          <pre class="tool-file-change-output"><span
            v-for="(line, index) in fileChangeLines"
            :key="index"
            :class="{ removed: isDiffFileChange && line.startsWith('- '), added: isDiffFileChange && line.startsWith('+ ') }"
          >{{ fileChangeLineText(line) }}</span></pre>
        </div>
        <p v-else class="tool-detail-note">{{ fileChangeView.emptyText }}</p>
      </div>
    </template>

    <template v-else-if="step.renderer === 'browser'">
      <p v-if="guardedBrowserText.isOversize" class="tool-content-oversize">
        Content is {{ formatBytes(guardedBrowserText.bytes) }}. It is larger than 100 kB and is not rendered inline.
      </p>
      <pre v-else class="tool-detail-output compact">{{ guardedBrowserText.text }}</pre>
    </template>

    <template v-else>
      <div class="tool-cli-card" :class="{ error: step.tone === 'error' }">
        <p v-if="guardedCliText.isOversize" class="tool-content-oversize">
          Content is {{ formatBytes(guardedCliText.bytes) }}. It is larger than 100 kB and is not rendered inline.
        </p>
        <pre v-else>{{ guardedCliText.text }}</pre>
      </div>
    </template>

    <details v-if="hasRawData" class="tool-detail-raw">
      <summary>
        <span>{{ uiText.tool.json }}</span>
        <span class="tool-detail-raw-caret" aria-hidden="true">
          <ChevronRight class="when-closed" :size="15" stroke-width="2" />
          <ChevronDown class="when-open" :size="15" stroke-width="2" />
        </span>
      </summary>
      <div class="tool-detail-raw-grid">
        <div v-if="step.inputRaw" class="process-json-block">
          <span>{{ jsonInputLabel }}</span>
          <p v-if="guardedInputRaw.isOversize" class="tool-content-oversize">
            Content is {{ formatBytes(guardedInputRaw.bytes) }}. It is larger than 100 kB and is not rendered inline.
          </p>
          <pre v-else>{{ guardedInputRaw.text }}</pre>
        </div>
        <div class="process-json-block">
          <span>{{ jsonOutputLabel }}</span>
          <p v-if="guardedOutputRaw.isOversize" class="tool-content-oversize">
            Content is {{ formatBytes(guardedOutputRaw.bytes) }}. It is larger than 100 kB and is not rendered inline.
          </p>
          <pre v-else>{{ guardedOutputRaw.text }}</pre>
        </div>
      </div>
    </details>
  </div>
</template>
