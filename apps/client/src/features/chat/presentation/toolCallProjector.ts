import type { AgentEvent } from '../model/conversation'

export type ToolCallExecutionStatus = 'streaming-args' | 'executing' | 'completed' | 'failed'

export type ToolCallViewState = {
  toolCallId: string
  toolName: string
  status: ToolCallExecutionStatus
  argumentsText: string
  arguments?: Record<string, unknown>
  startedAt: number
  argsUpdatedAt?: number
  completedAt?: number
}

export function projectToolCalls(events: AgentEvent[]) {
  const calls = new Map<string, ToolCallViewState>()

  for (const event of events) {
    applyToolCallEvent(calls, event)
  }

  return calls
}

export function applyToolCallEvent(calls: Map<string, ToolCallViewState>, event: AgentEvent) {
  if (event.type === 'tool_call.started') {
    calls.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolCallName, status: 'streaming-args', argumentsText: '', startedAt: event.timestamp })
  } else if (event.type === 'tool_call.args') {
    const call = ensureCall(calls, event.toolCallId, event.timestamp)
    call.argumentsText += event.delta
    call.arguments = parseArguments(call.argumentsText)
    call.argsUpdatedAt = event.timestamp
  } else if (event.type === 'tool_call.completed') {
    const call = ensureCall(calls, event.toolCallId, event.timestamp)
    call.status = 'executing'
    call.completedAt = event.timestamp
  } else if (event.type === 'tool_result.completed' || event.type === 'tool_result.failed') {
    const call = ensureCall(calls, event.toolCallId, event.timestamp, event.toolName)
    call.status = event.type === 'tool_result.failed' ? 'failed' : 'completed'
    call.completedAt = event.timestamp
  }
}

export function toolCallSummaryArguments(call: ToolCallViewState | undefined) {
  if (!call) return {}
  if (call.arguments) return pickSummaryArguments(call.arguments)

  const summary: Record<string, unknown> = {}
  for (const key of SUMMARY_ARGUMENT_KEYS) {
    const value = extractIncompleteString(call.argumentsText, key)
    if (value) summary[key] = value
  }
  return summary
}

const SUMMARY_ARGUMENT_KEYS = [
  'path', 'file', 'filePath', 'cwd',
  'command', 'cmd', 'script',
  'query', 'pattern', 'q', 'url',
] as const

function pickSummaryArguments(argumentsValue: Record<string, unknown>) {
  const summary: Record<string, unknown> = {}
  for (const key of SUMMARY_ARGUMENT_KEYS) {
    const value = argumentsValue[key]
    if (typeof value === 'string' || typeof value === 'number') summary[key] = value
  }
  return summary
}

function extractIncompleteString(json: string, key: string) {
  const keyIndex = json.search(new RegExp(`"${key}"\\s*:\\s*"`, 'i'))
  if (keyIndex < 0) return ''

  const valueStart = json.indexOf('"', json.indexOf(':', keyIndex) + 1) + 1
  if (valueStart <= 0) return ''

  let escaped = false
  let value = ''
  for (let index = valueStart; index < json.length; index += 1) {
    const character = json[index]
    if (!escaped && character === '"') break
    if (!escaped && character === '\\') {
      escaped = true
      continue
    }
    if (escaped) {
      value += character === 'n' ? '\n' : character === 't' ? '\t' : character
      escaped = false
      continue
    }
    value += character
  }
  return value.trim()
}

function ensureCall(calls: Map<string, ToolCallViewState>, id: string, timestamp: number, name = 'tool') {
  let call = calls.get(id)
  if (!call) {
    call = { toolCallId: id, toolName: name || 'tool', status: 'streaming-args', argumentsText: '', startedAt: timestamp }
    calls.set(id, call)
  }
  return call
}

function parseArguments(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
