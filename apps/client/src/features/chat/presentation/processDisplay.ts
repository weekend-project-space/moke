import type {
  ProcessGroupView,
  ProcessItem,
  ProcessViewItem,
  ToolRendererKind,
  ToolStepSummary,
  ToolStepViewItem,
  ToolStepState,
} from './types'
import type { ToolApprovalRecord } from '../model/conversation'
import { summarizeOutput } from './toolDisplay'
import { uiText } from '../../../text/uiText'

const DONE = uiText.process.done

export function createProcessGroupView(items: ProcessItem[]): ProcessGroupView {
  const viewItems = mergeToolSteps(items)
  const times = processItemTimes(viewItems)

  return {
    label: uiText.process.details,
    items: viewItems,
    hasError: viewItems.some((item) => item.tone === 'error'),
    startedAt: times[0],
    endedAt: times.at(-1),
  }
}

export function formatProcessGroupStatus(group: ProcessGroupView, isActive = false, runtimeNow = Date.now()) {
  if (!group.startedAt) return { durationLabel: '', label: uiText.process.details }

  const end = isActive ? runtimeNow : group.endedAt || group.startedAt
  const durationLabel = formatDuration(end - group.startedAt)
  const statusLabel = isActive ? uiText.process.working : uiText.process.processed
  return {
    durationLabel,
    label: `${statusLabel} · ${durationLabel}`,
  }
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
        step.outputRaw = item.raw
        const outputSummary = summarizeToolResult(step.renderer, item.raw)
        const resultTone = step.renderer === 'command' && outputSummary.exitCode !== undefined && outputSummary.exitCode !== 0
          ? 'error'
          : item.tone
        step.tone = resultTone
        step.summary = {
          ...step.summary,
          ...outputSummary,
        }
        if (step.toolCategory !== 'skill') {
          step.objectLabel = combineToolStepDetail(step.objectLabel, item.raw, resultTone)
        }
        step.approvals = item.approvals
        step.state = resolveToolStepState(resultTone, item.approvals)
        step.executionStatus = item.executionStatus
        if (call?.toolCallId) pendingCalls.delete(call.toolCallId)
        if (lastPendingCall === call) lastPendingCall = null
        continue
      }

      viewItems.push(item)
      continue
    }

    viewItems.push(item)
  }

  return viewItems
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

function createToolStepView(call: ProcessItem): ToolStepViewItem {
  return {
    id: `process-tool-step-${call.id}`,
    kind: 'tool-step',
    title: call.title,
    detail: call.detail,
    tone: call.tone,
    time: call.time,
    toolName: call.title,
    actionLabel: call.actionLabel || uiText.tool.runTool,
    objectLabel: call.objectLabel || call.detail,
    renderer: call.renderer || 'generic',
    summary: call.summary || {},
    toolCategory: call.toolCategory || 'run',
    inputRaw: call.raw,
    approvals: call.approvals,
    state: resolveToolStepState(call.tone, call.approvals),
    executionStatus: call.executionStatus,
  }
}

export function resolveToolStepState(
  tone: ProcessItem['tone'],
  approvals: ToolApprovalRecord[] = [],
): ToolStepState | undefined {
  const approval = approvals.at(-1)
  if (approval?.decision === 'rejected') {
    return { kind: 'rejected', label: uiText.tool.approvalRejected }
  }
  if (tone === 'error') {
    return { kind: 'failed', label: uiText.process.failed }
  }
  if (approval?.decision === 'approved') {
    const label = approval.scope === 'persistent'
      ? uiText.tool.approvalAllowedAlways
      : approval.scope === 'session'
        ? uiText.tool.approvalAllowedSession
        : uiText.tool.approvalAllowedOnce
    return { kind: 'approved', label: approval.reviewer ? `${label} (${approval.reviewer})` : label }
  }
  return undefined
}

function summarizeToolResult(renderer: ToolRendererKind, outputRaw: string | undefined): ToolStepSummary {
  if (!outputRaw) return {}

  try {
    const parsed = JSON.parse(outputRaw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { preview: String(parsed ?? '') }
    }

    const output = parsed as Record<string, unknown>

    if (renderer === 'ask-user') {
      const selected = output.selected && typeof output.selected === 'object' && !Array.isArray(output.selected)
        ? output.selected as Record<string, unknown>
        : {}
      return {
        question: typeof output.question === 'string' ? output.question : undefined,
        selectedLabel: typeof selected.label === 'string' ? selected.label : undefined,
      }
    }

    if (renderer === 'search') {
      const results = Array.isArray(output.results) ? output.results : []
      const matches = Array.isArray(output.matches) ? output.matches : []
      const searchableItems = results.length ? results : matches
      return {
        count: typeof output.count === 'number' ? output.count : searchableItems.length,
        files: extractResultFiles(searchableItems),
        preview: output.error ? String(output.error) : searchResultPreview(results),
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

    if (renderer === 'channel') {
      return { preview: channelResultPreview(output) }
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

function previewFromOutput(output: Record<string, unknown>) {
  for (const key of ['content', 'text', 'stdout', 'data']) {
    const value = output[key]
    if (typeof value === 'string' && value.trim()) return value
  }

  return summarizeOutput(output)
}

function browserResultPreview(output: Record<string, unknown>) {
  const snapshot = objectValue(output.snapshot)
  const pages = Array.isArray(output.pages) ? output.pages : []
  const activePageId = typeof output.activePageId === 'number' ? output.activePageId : null
  const active = objectValue(pages.find((page) => objectValue(page).pageId === activePageId))
  const title = firstText('title', output, snapshot, active)
  const url = firstText('url', output, snapshot, active)
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements.length : 0
  const details = [
    title,
    url,
    elements ? `${elements} elements` : '',
    pages.length ? `${pages.length} tab${pages.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  if (details.length) return details.join(' · ')

  const text = typeof output.text === 'string' ? output.text.trim() : ''
  const message = typeof output.message === 'string' ? output.message.trim() : ''

  if (title && url) return `${title} · ${url}`
  if (title) return title
  if (url) return url
  if (text) return text
  if (message) return message
  return summarizeOutput(output)
}

function channelResultPreview(output: Record<string, unknown>) {
  const receipts = Array.isArray(output.receipts) ? output.receipts : []
  if (!receipts.length) return summarizeOutput(output)

  const types = [...new Set(receipts.map((receipt) => objectValue(receipt).type).filter((type): type is string => typeof type === 'string'))]
  const target = types.length ? ` (${types.join(', ')})` : ''
  return `Delivered to ${receipts.length} message${receipts.length === 1 ? '' : 's'}${target}`
}

function searchResultPreview(results: unknown[]) {
  const snippet = objectValue(results[0]).snippet
  if (typeof snippet !== 'string' || !snippet.trim()) return undefined
  return shortPreview(snippet)
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstText(key: string, ...sources: Record<string, unknown>[]) {
  for (const source of sources) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  return ''
}

function shortPreview(value: string) {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= 120 ? text : `${text.slice(0, 119)}...`
}

function processItemTimes(items: ProcessViewItem[]) {
  return items
    .map((item) => item.time)
    .filter((time): time is number => Boolean(time && time > 0))
    .sort((left, right) => left - right)
}

function formatDuration(durationMs: number) {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`
}
