import { computed, type Ref } from 'vue'
import type { AgentEvent, Message } from '../model/conversation'
import type { DisplayItem, ProcessItem, ProcessNote } from './types'
import { createProcessGroupView, formatProcessGroupStatus } from './processDisplay'
import { uiText } from '../../../text/uiText'
import {
  describeToolCall,
  formatJson,
  formatToolName,
  parseToolContent,
  shortText,
  summarizeOutput,
} from './toolDisplay'

const MESSAGE_TIME_GAP_MS = 10 * 60 * 1000

type ToolCallEvent = Extract<AgentEvent, { type: 'tool.call' }>
type ToolResultEvent = Extract<AgentEvent, { type: 'tool.result' }>

type UseConversationDisplayOptions = {
  messages: Ref<Message[]>
  events: Ref<AgentEvent[]>
  isRunning: Ref<boolean>
  runtimeNow: Ref<number>
  runError: Ref<string>
  processCollapsed: Ref<Record<string, boolean>>
  toolLabels: Record<string, string>
  formatTimelineTime: (time: number) => string
}

export function useConversationDisplay(options: UseConversationDisplayOptions) {
  const visibleMessages = computed(() => options.messages.value.filter(isVisibleMessage))
  const lastAssistantMessage = computed(() =>
    [...visibleMessages.value].reverse().find((message) => message.role === 'assistant' && message.content.trim()),
  )

  const activeEventProcessItems = computed<ProcessItem[]>(() => {
    const items: ProcessItem[] = []
    const callsById = new Map<string, ToolCallEvent>()
    let reasoningText = ''
    let reasoningTime = 0
    let reasoningId = ''
    let reasoningStepId = ''

    function flushReasoning() {
      if (!reasoningText.trim()) return

      items.push(createEventProcessItem({
        id: reasoningId || `reasoning-${items.length}`,
        label: shortText(reasoningText, 96),
        raw: reasoningText.trim(),
        tone: 'neutral',
        time: reasoningTime,
      }))
      reasoningText = ''
      reasoningTime = 0
      reasoningId = ''
      reasoningStepId = ''
    }

    for (const event of options.events.value) {
      if (event.type === 'agent.message.delta' && event.payload.channel === 'reasoning') {
        const content = typeof event.payload.content === 'string' ? event.payload.content : ''
        const stepId = event.step ? `${event.step.index}:${event.step.phase}` : ''
        if (!content) continue
        if (reasoningText && stepId && reasoningStepId && stepId !== reasoningStepId) flushReasoning()

        reasoningText += content
        reasoningTime = reasoningTime || parseEventTime(event)
        reasoningId = reasoningId || `reasoning-${stepId || event.id}`
        reasoningStepId = reasoningStepId || stepId
        continue
      }

      flushReasoning()

      if (event.type === 'tool.call') {
        callsById.set(String(event.payload.call_id || event.id), event)
        items.push(createToolCallEventProcessItem(event, options.toolLabels))
        continue
      }

      if (event.type === 'tool.result') {
        const callId = String(event.payload.call_id || '')
        items.push(createToolResultEventProcessItem(event, callsById.get(callId)))
        continue
      }

      if (event.type === 'agent.error') {
        items.push(createEventProcessItem({
          id: `process-${event.id}`,
          label: `Run failed: ${shortText(String(event.payload.message || uiText.process.unknownError), 72)}`,
          tone: 'error',
          time: parseEventTime(event),
        }))
      }
    }

    flushReasoning()
    return items
  })

  const displayItems = computed<DisplayItem[]>(() => {
    const items: DisplayItem[] = []
    const sourceMessages = options.messages.value.filter(
      (message) => message.role !== 'tool' || Boolean(message.content.trim()),
    )
    let lastTime = 0
    let turnIndex = 0
    let turnStartedAt = 0
    let turnEndedAt = 0
    let processItems: ProcessItem[] = []
    let pendingFinalMessage: { id: string; message: Message } | null = null
    let hasActiveMessageProcessGroup = false

    function pushTime(time: number, index: number) {
      if (time && (lastTime === 0 || time - lastTime >= MESSAGE_TIME_GAP_MS)) {
        items.push({
          type: 'time',
          id: `time-${index}-${time}`,
          label: options.formatTimelineTime(time),
        })
        lastTime = time
      }
    }

    function flushAssistantTurn(nextTime = 0) {
      if (!processItems.length && !pendingFinalMessage) return

      if (processItems.length) {
        const isCurrentTurn = options.isRunning.value && nextTime === 0
        const groupId = `process-turn-${turnIndex}`
        const nextProcessItems = isCurrentTurn
          ? mergeProcessItems(processItems, activeEventProcessItems.value)
          : processItems
        const processGroup = createProcessGroupView(nextProcessItems)
        const startedAt = turnStartedAt || processGroup.startedAt
        const endedAt = isCurrentTurn ? options.runtimeNow.value : turnEndedAt || processGroup.endedAt || startedAt
        const status = formatProcessGroupStatus(
          { ...processGroup, startedAt, endedAt },
          isCurrentTurn,
          options.runtimeNow.value,
        )
        if (isCurrentTurn) hasActiveMessageProcessGroup = true
        items.push({
          type: 'process-group',
          id: groupId,
          label: status.label,
          durationLabel: status.durationLabel,
          items: processGroup.items,
          collapsed: options.processCollapsed.value[groupId] ?? !isCurrentTurn,
          hasError: processGroup.hasError,
          isActive: isCurrentTurn,
        })
      }

      if (pendingFinalMessage && pendingFinalMessage.message.content.trim()) {
        pushTime(parseMessageTime(pendingFinalMessage.message) || nextTime, turnIndex)
        items.push({
          type: 'message',
          id: pendingFinalMessage.id,
          message: pendingFinalMessage.message,
        })
      }

      turnIndex += 1
      turnStartedAt = 0
      turnEndedAt = 0
      processItems = []
      pendingFinalMessage = null
    }

    function movePendingFinalToProcess() {
      if (!pendingFinalMessage) return

      processItems.push(createAssistantProcessItem(pendingFinalMessage.message, pendingFinalMessage.id))
      pendingFinalMessage = null
    }

    sourceMessages.forEach((message, index) => {
      const time = parseMessageTime(message)

      if (message.role === 'user') {
        flushAssistantTurn(time)
        turnStartedAt = time
        turnEndedAt = 0
        pushTime(time, index)
        items.push({
          type: 'message',
          id: `message-${index}`,
          message,
        })
        return
      }

      if (message.role === 'tool') {
        movePendingFinalToProcess()
        processItems.push(createToolResultProcessItem(message, `message-${index}`))
        if (time) turnEndedAt = time
        return
      }

      if (message.tool_calls?.length) {
        movePendingFinalToProcess()
        if (message.reasoning?.trim()) {
          processItems.push(createReasoningProcessItem(message, `message-${index}`))
        }
        if (message.content.trim()) processItems.push(createAssistantProcessItem(message, `message-${index}`))
        for (const toolCall of message.tool_calls) {
          processItems.push(createToolCallProcessItem(toolCall, `message-${index}-${toolCall.id}`))
        }
        return
      }

      if (message.content.trim()) {
        movePendingFinalToProcess()
        if (message.reasoning?.trim()) {
          processItems.push(createReasoningProcessItem(message, `message-${index}`))
        }
        pendingFinalMessage = { id: `message-${index}`, message }
        if (time) turnEndedAt = time
      }
    })

    flushAssistantTurn()

    if (
      (options.isRunning.value || options.runError.value) &&
      activeEventProcessItems.value.length &&
      !hasActiveMessageProcessGroup
    ) {
      const groupId = 'process-current-events'
      const processGroup = createProcessGroupView(activeEventProcessItems.value)
      const startedAt = latestUserMessageTime(sourceMessages) || processGroup.startedAt
      const endedAt = options.isRunning.value ? options.runtimeNow.value : processGroup.endedAt || startedAt
      const status = formatProcessGroupStatus(
        { ...processGroup, startedAt, endedAt },
        options.isRunning.value,
        options.runtimeNow.value,
      )
      items.push({
        type: 'process-group',
        id: groupId,
        label: status.label,
        durationLabel: status.durationLabel,
        items: processGroup.items,
        collapsed: options.processCollapsed.value[groupId] ?? !options.isRunning.value,
        hasError: processGroup.hasError,
        isActive: options.isRunning.value,
      })
    }

    return items
  })

  function toggleProcessGroup(id: string) {
    options.processCollapsed.value = {
      ...options.processCollapsed.value,
      [id]: !(options.processCollapsed.value[id] ?? true),
    }
  }

  return {
    displayItems,
    lastAssistantMessage,
    toggleProcessGroup,
    visibleMessages,
  }
}

export function isVisibleMessage(message: Message) {
  return message.role !== 'tool' && Boolean(message.content.trim())
}

export function parseMessageTime(message: Message) {
  if (!message.created_at) return 0

  const time = Date.parse(message.created_at)
  return Number.isNaN(time) ? 0 : time
}

function latestUserMessageTime(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue

    const time = parseMessageTime(message)
    if (time) return time
  }

  return 0
}

function parseEventTime(event: AgentEvent) {
  const time = Date.parse(event.ts)
  return Number.isNaN(time) ? 0 : time
}

function createAssistantProcessItem(message: Message, id: string): ProcessItem {
  return {
    id: `process-assistant-${id}`,
    kind: 'assistant',
    title: '',
    detail: shortText(message.content, 140),
    tone: 'neutral',
    time: parseMessageTime(message),
    raw: message.content,
  }
}

function createToolCallProcessItem(toolCall: NonNullable<Message['tool_calls']>[number], id: string): ProcessItem {
  const description = describeToolCall(toolCall.name, toolCall.args)

  return {
    id: `process-tool-call-${id}`,
    kind: 'tool-call',
    title: toolCall.name,
    detail: description.objectLabel,
    tone: 'neutral',
    time: 0,
    actionLabel: description.actionLabel,
    objectLabel: description.objectLabel,
    renderer: description.renderer,
    summary: description.summary,
    toolCategory: description.toolCategory,
    raw: formatJson(toolCall.args),
    toolCallId: toolCall.id,
  }
}

function mergeProcessItems(messageItems: ProcessItem[], eventItems: ProcessItem[]) {
  if (!eventItems.length) return messageItems
  if (!messageItems.length) return eventItems

  const merged = [...messageItems]
  const seenToolCallIds = new Set(
    messageItems
      .map((item) => item.toolCallId)
      .filter((toolCallId): toolCallId is string => Boolean(toolCallId)),
  )
  const seenReasoning = new Set(
    messageItems
      .filter((item) => item.kind === 'reasoning' && item.raw)
      .map((item) => normalizeComparableText(item.raw || '')),
  )
  const seenRaw = new Set(
    messageItems
      .filter((item) => item.raw)
      .map((item) => normalizeComparableText(item.raw || '')),
  )

  for (const item of eventItems) {
    if (item.toolCallId && seenToolCallIds.has(item.toolCallId)) continue

    const comparableRaw = normalizeComparableText(item.raw || '')
    if (item.kind === 'reasoning' && comparableRaw && seenReasoning.has(comparableRaw)) continue
    if (item.kind !== 'event' && comparableRaw && seenRaw.has(comparableRaw)) continue

    merged.push(item)
    if (item.toolCallId) seenToolCallIds.add(item.toolCallId)
    if (comparableRaw) seenRaw.add(comparableRaw)
    if (item.kind === 'reasoning' && comparableRaw) seenReasoning.add(comparableRaw)
  }

  return merged
}

function normalizeComparableText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function createToolCallEventProcessItem(event: ToolCallEvent, toolLabels: Record<string, string>): ProcessItem {
  const name = String(event.payload.tool || '')
  const input = toRecord(event.payload.input)
  const description = describeToolCall(name, input)
  const callId = String(event.payload.call_id || event.id)

  return {
    id: `process-tool-call-event-${event.id}`,
    kind: 'tool-call',
    title: formatToolName(name, toolLabels),
    detail: description.objectLabel,
    tone: 'neutral',
    time: parseEventTime(event),
    actionLabel: description.actionLabel,
    objectLabel: description.objectLabel,
    renderer: description.renderer,
    summary: description.summary,
    toolCategory: description.toolCategory,
    raw: formatJson(input),
    toolCallId: callId,
  }
}

function createToolResultProcessItem(message: Message, id: string): ProcessItem {
  const parsed = parseToolContent(message.content)
  const detail =
    message.status === 'error'
      ? summarizeToolFailure(parsed, message.name)
      : typeof parsed === 'string'
        ? parsed
        : summarizeOutput(parsed)
  const raw = typeof parsed === 'string' ? parsed : formatJson(parsed)

  return {
    id: `process-tool-result-${id}`,
    kind: 'tool-result',
    title: message.name || 'tool',
    detail: shortText(detail, 160),
    tone: message.status === 'error' ? 'error' : 'neutral',
    actionLabel: message.status === 'error' ? uiText.process.failed : uiText.process.validationResult,
    time: parseMessageTime(message),
    objectLabel: shortText(detail, 120),
    renderer: 'generic',
    summary: {},
    toolCategory: 'run',
    raw,
    toolCallId: message.tool_call_id,
  }
}

function createToolResultEventProcessItem(event: ToolResultEvent, callEvent?: ToolCallEvent): ProcessItem {
  const output = event.payload.output
  const toolName = String(callEvent?.payload.tool || 'tool')
  const parsedOutput = typeof output === 'string' ? parseToolContent(output) : output
  const detail =
    event.payload.status === 'error'
      ? summarizeToolFailure(parsedOutput, toolName)
      : typeof parsedOutput === 'string'
        ? parsedOutput
        : summarizeOutput(toRecord(parsedOutput))
  const description = describeToolCall(toolName, toRecord(callEvent?.payload.input))
  const raw = typeof parsedOutput === 'string' ? parsedOutput : formatJson(parsedOutput)

  return {
    id: `process-tool-result-event-${event.id}`,
    kind: 'tool-result',
    title: toolName,
    detail: shortText(detail, 160),
    tone: event.payload.status === 'error' ? 'error' : 'neutral',
    actionLabel: event.payload.status === 'error' ? uiText.process.failed : uiText.process.validationResult,
    time: parseEventTime(event),
    objectLabel: shortText(detail, 120),
    renderer: description.renderer,
    summary: {},
    toolCategory: description.toolCategory,
    raw,
    toolCallId: String(event.payload.call_id || ''),
  }
}

function createReasoningProcessItem(message: Message, id: string): ProcessItem {
  const reasoning = message.reasoning?.trim() || ''

  return {
    id: `process-reasoning-${id}`,
    kind: 'reasoning',
    title: uiText.process.reasoning,
    detail: shortText(reasoning, 96),
    tone: 'neutral',
    actionLabel: uiText.process.reasoning,
    time: parseMessageTime(message),
    objectLabel: shortText(reasoning, 96),
    renderer: 'generic',
    summary: { preview: shortText(reasoning, 96) },
    toolCategory: 'run',
    raw: reasoning,
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function summarizeToolFailure(parsed: unknown, fallbackName?: string) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const error = (parsed as Record<string, unknown>).error
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const errorRecord = error as Record<string, unknown>
      const tool = typeof errorRecord.tool === 'string' ? errorRecord.tool : fallbackName
      const path = typeof errorRecord.path === 'string' ? errorRecord.path : ''
      const message = typeof errorRecord.message === 'string' ? errorRecord.message : ''
      const target = path || extractPathFromErrorMessage(message)
      return target ? `${tool || uiText.process.tool} · ${target}` : `${tool || uiText.process.tool} failed`
    }
  }

  return fallbackName ? `${fallbackName} failed` : uiText.process.toolFailedFallback
}

function extractPathFromErrorMessage(message: string) {
  const quoted = message.match(/'([^']+)'/)
  if (quoted?.[1]) return quoted[1]

  const windowsPath = message.match(/[a-zA-Z]:\\[^\s,)]+/)
  return windowsPath?.[0] || ''
}

function createEventProcessItem(note: ProcessNote): ProcessItem {
  if (note.raw) {
    return {
      id: `process-event-${note.id}`,
      kind: 'reasoning',
      title: uiText.process.reasoning,
      detail: note.label,
      tone: note.tone,
      actionLabel: uiText.process.reasoning,
      time: note.time,
      objectLabel: note.label,
      renderer: 'generic',
      summary: { preview: note.label },
      toolCategory: 'run',
      raw: note.raw,
    }
  }

  return {
    id: `process-event-${note.id}`,
    kind: 'event',
    title: note.tone === 'error' ? uiText.process.runIssue : uiText.process.runStatus,
    detail: note.label,
    tone: note.tone,
    actionLabel: note.tone === 'error' ? uiText.process.issue : uiText.process.eventStatus,
    time: note.time,
    objectLabel: note.label,
    renderer: 'generic',
    summary: { preview: note.label },
    toolCategory: 'run',
  }
}
