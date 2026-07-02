import type {
  ProcessGroupView,
  ProcessItem,
  ProcessViewItem,
  ToolRendererKind,
  ToolBatchViewItem,
  ToolStepSummary,
  ToolStepViewItem,
} from '../types/conversation'
import { summarizeOutput } from './toolDisplay'

const DONE = '\u5df2\u5b8c\u6210'

export function createProcessGroupView(items: ProcessItem[]): ProcessGroupView {
  const viewItems = mergeToolSteps(items)
  const times = processItemTimes(viewItems)

  return {
    label: '\u5904\u7406\u7ec6\u8282',
    items: viewItems,
    hasError: viewItems.some((item) => item.tone === 'error'),
    startedAt: times[0],
    endedAt: times.at(-1),
  }
}

export function formatProcessGroupLabel(group: ProcessGroupView, isActive = false, runtimeNow = Date.now()) {
  if (!group.startedAt) return '\u5904\u7406\u7ec6\u8282'

  const end = isActive ? runtimeNow : group.endedAt || group.startedAt
  return `\u5df2\u5904\u7406 ${formatDuration(end - group.startedAt)}`
}

function mergeToolSteps(items: ProcessItem[]): ProcessViewItem[] {
  const viewItems: ProcessViewItem[] = []
  const pendingCalls = new Map<string, ProcessItem>()
  let lastPendingCall: ProcessItem | null = null

  function pushToolCall(call: ProcessItem) {
    const step = createToolStepView(call)
    viewItems.push(step)
    if (call.toolCallId) pendingCalls.set(call.toolCallId, call)
    lastPendingCall = call
  }

  function findStep(call: ProcessItem | null) {
    if (!call) return null
    return viewItems.find(
      (item): item is ToolStepViewItem => item.kind === 'tool-step' && item.id === `process-tool-step-${call.id}`,
    )
  }

  for (const item of items) {
    if (item.kind === 'tool-call') {
      pushToolCall(item)
      continue
    }

    if (item.kind === 'tool-result') {
      let call: ProcessItem | null = lastPendingCall
      if (item.toolCallId) call = pendingCalls.get(item.toolCallId) || null
      const step = findStep(call)

      if (step) {
        step.tone = item.tone
        step.outputRaw = item.raw
        step.summary = {
          ...step.summary,
          ...summarizeToolResult(step.renderer, item.raw),
        }
        step.objectLabel = combineToolStepDetail(step.objectLabel, item.raw, item.tone)
        if (call?.toolCallId) pendingCalls.delete(call.toolCallId)
        if (lastPendingCall === call) lastPendingCall = null
        continue
      }

      viewItems.push(item)
      continue
    }

    viewItems.push(item)
  }

  return mergeAdjacentToolBatches(viewItems)
}

function combineToolStepDetail(inputLabel: string, outputRaw: string | undefined, tone: ProcessItem['tone']) {
  if (tone === 'error') return inputLabel
  if (!outputRaw) return inputLabel

  try {
    const parsed = JSON.parse(outputRaw)
    const outputSummary = summarizeOutput(parsed)
    if (outputSummary && outputSummary !== DONE) return `${inputLabel} · ${outputSummary}`
  } catch {
    const text = outputRaw.replace(/\s+/g, ' ').trim()
    if (text && text !== DONE) return inputLabel
  }

  return inputLabel
}

function mergeAdjacentToolBatches(items: ProcessViewItem[]): ProcessViewItem[] {
  const merged: ProcessViewItem[] = []
  let batch: ToolStepViewItem[] = []

  function canBatch(left: ToolStepViewItem, right: ToolStepViewItem) {
    return (
      left.actionLabel === right.actionLabel &&
      left.toolCategory === right.toolCategory &&
      left.tone === right.tone
    )
  }

  function flushBatch() {
    if (batch.length === 0) return
    if (batch.length === 1) {
      merged.push(batch[0])
      batch = []
      return
    }

    merged.push(createToolBatchView(batch))
    batch = []
  }

  for (const item of items) {
    if (item.kind !== 'tool-step') {
      flushBatch()
      merged.push(item)
      continue
    }

    const last = batch.at(-1)
    if (!last || canBatch(last, item)) {
      batch.push(item)
      continue
    }

    flushBatch()
    batch.push(item)
  }

  flushBatch()
  return merged
}

function createToolBatchView(steps: ToolStepViewItem[]): ToolBatchViewItem {
  const first = steps[0]
  const countLabel = toolBatchCountLabel(first, steps.length)

  return {
    id: `process-tool-batch-${first.id}-${steps.length}`,
    kind: 'tool-batch',
    title: first.title,
    detail: countLabel,
    tone: steps.some((step) => step.tone === 'error') ? 'error' : first.tone,
    actionLabel: first.actionLabel,
    objectLabel: '',
    countLabel,
    renderer: first.renderer,
    toolCategory: first.toolCategory,
    steps,
  }
}

function toolBatchCountLabel(step: ToolStepViewItem, count: number) {
  if (step.renderer === 'directory') return `${count} \u4e2a\u76ee\u5f55`
  return `${count} \u9879`
}

function createToolStepView(call: ProcessItem): ToolStepViewItem {
  return {
    id: `process-tool-step-${call.id}`,
    kind: 'tool-step',
    title: call.title,
    detail: call.detail,
    tone: call.tone,
    time: call.time,
    toolName: call.title,
    actionLabel: call.actionLabel || '\u8fd0\u884c\u5de5\u5177',
    objectLabel: call.objectLabel || call.detail,
    renderer: call.renderer || 'generic',
    summary: call.summary || {},
    toolCategory: call.toolCategory || 'run',
    inputRaw: call.raw,
  }
}

function summarizeToolResult(renderer: ToolRendererKind, outputRaw: string | undefined): ToolStepSummary {
  if (!outputRaw) return {}

  try {
    const parsed = JSON.parse(outputRaw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { preview: String(parsed ?? '') }
    }

    const output = parsed as Record<string, any>

    if (renderer === 'search') {
      const matches = Array.isArray(output.matches) ? output.matches : []
      return {
        count: typeof output.count === 'number' ? output.count : matches.length,
        files: extractResultFiles(matches),
        preview: output.error ? String(output.error) : undefined,
      }
    }

    if (renderer === 'directory') {
      const entries = Array.isArray(output.entries) ? output.entries : []
      return {
        count: entries.length,
        files: extractDirectoryEntries(entries),
        path: typeof output.path === 'string' ? output.path : undefined,
        preview: output.error ? String(output.error) : undefined,
      }
    }

    if (renderer === 'command') {
      return {
        exitCode: typeof output.exit_code === 'number' ? output.exit_code : undefined,
        stderr: typeof output.stderr === 'string' ? output.stderr : undefined,
        stdout: typeof output.stdout === 'string' ? output.stdout : undefined,
      }
    }

    if (renderer === 'file-read') {
      return { preview: previewFromOutput(output) }
    }

    if (renderer === 'file-change') {
      return {
        path: typeof output.path === 'string' ? output.path : undefined,
        preview: output.error ? String(output.error) : undefined,
      }
    }

    if (renderer === 'browser') {
      return { preview: browserResultPreview(output) }
    }

    return { preview: summarizeOutput(output) }
  } catch {
    return { preview: outputRaw }
  }
}
function extractResultFiles(matches: unknown[]) {
  return [
    ...new Set(
      matches
        .map((match) => {
          if (typeof match === 'string') return match
          if (match && typeof match === 'object') {
            const record = match as Record<string, unknown>
            const value = record.path || record.file || record.name
            return typeof value === 'string' ? value : ''
          }
          return ''
        })
        .filter(Boolean),
    ),
  ]
}

function extractDirectoryEntries(entries: unknown[]) {
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        const path = typeof record.path === 'string' ? record.path : ''
        const type = record.type === 'directory' ? '/' : ''
        const name = path.split(/[\\/]/).filter(Boolean).at(-1) || path
        return name ? `${name}${type}` : ''
      }
      return ''
    })
    .filter(Boolean)
}

function previewFromOutput(output: Record<string, any>) {
  for (const key of ['content', 'text', 'stdout', 'data']) {
    const value = output[key]
    if (typeof value === 'string' && value.trim()) return value
  }

  return summarizeOutput(output)
}

function browserResultPreview(output: Record<string, any>) {
  const title = typeof output.title === 'string' ? output.title.trim() : ''
  const url = typeof output.url === 'string' ? output.url.trim() : ''
  const text = typeof output.text === 'string' ? output.text.trim() : ''
  const message = typeof output.message === 'string' ? output.message.trim() : ''

  if (title && url) return `${title} · ${url}`
  if (title) return title
  if (url) return url
  if (text) return text
  if (message) return message
  return summarizeOutput(output)
}

function processItemTimes(items: ProcessViewItem[]) {
  return items
    .flatMap((item) => {
      if (item.kind === 'tool-batch') return [item.time, ...item.steps.map((step) => step.time)]
      return [item.time]
    })
    .filter((time): time is number => Boolean(time && time > 0))
    .sort((left, right) => left - right)
}

function formatDuration(durationMs: number) {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds} \u79d2`

  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) return restSeconds ? `${minutes} \u5206 ${restSeconds} \u79d2` : `${minutes} \u5206`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes ? `${hours} \u5c0f\u65f6 ${restMinutes} \u5206` : `${hours} \u5c0f\u65f6`
}
