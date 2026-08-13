import { computed, type Ref } from 'vue'
import type { AgentEvent, Message, PendingApproval, PendingAsk } from '../model/conversation'
import type { DisplayItem, ProcessItem, ProcessNote } from './types'
import { createProcessGroupView, formatProcessGroupStatus } from './processDisplay'
import { uiText } from '../../../text/uiText'
import {
  describeToolCall,
  formatJson,
  parseToolContent,
  shortText,
  summarizeOutput,
} from './toolDisplay'

const MESSAGE_TIME_GAP_MS = 10 * 60 * 1000

type ToolCreatedEvent = Extract<AgentEvent, { type: 'tool_call.started' }>
type ToolReadyEvent = Extract<AgentEvent, { type: 'tool_call.args' }>
type ToolCompletedEvent = Extract<AgentEvent, { type: 'tool_result.completed' | 'tool_result.failed' }>

type UseConversationDisplayOptions = {
  messages: Ref<Message[]>
  events: Ref<AgentEvent[]>
  isRunning: Ref<boolean>
  runtimeNow: Ref<number>
  runError: Ref<string>
  pendingAsk: Ref<PendingAsk | null>
  pendingApproval: Ref<PendingApproval | null>
  processCollapsed: Ref<Record<string, boolean>>
  formatTimelineTime: (time: number) => string
}

export function useConversationDisplay(options: UseConversationDisplayOptions) {
  const visibleMessages = computed(() => options.messages.value.filter(isVisibleMessage))
  const lastAssistantMessage = computed(() =>
    [...visibleMessages.value].reverse().find((message) => message.role === 'assistant' && message.content.trim()),
  )

  const activeEventProcessItems = computed<ProcessItem[]>(() => {
    const items: ProcessItem[] = []
    const callsById = new Map<string, ToolCreatedEvent>()
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
      if (event.type === 'reasoning_message.content') {
        const content = event.delta
        const stepId = event.stepId || ''
        if (!content) continue
        if (reasoningText && stepId && reasoningStepId && stepId !== reasoningStepId) flushReasoning()

        reasoningText += content
        reasoningTime = reasoningTime || parseEventTime(event)
        reasoningId = reasoningId || `reasoning-${stepId || event.eventId}`
        reasoningStepId = reasoningStepId || stepId
        continue
      }

      flushReasoning()

      if (event.type === 'tool_call.started') {
        const callId = event.toolCallId
        callsById.set(callId, event)
        if (isPendingInteractionCall(event.toolCallName, callId, options)) continue
        items.push(createToolCreatedEventProcessItem(event))
        continue
      }

      if (event.type === 'tool_call.args') {
        const callId = event.toolCallId
        const call = callsById.get(callId)
        if (call && isPendingInteractionCall(call.toolCallName, callId, options)) continue
        items.push(createToolReadyEventProcessItem(event))
        continue
      }

      if (event.type === 'tool_result.completed' || event.type === 'tool_result.failed') {
        const callId = event.toolCallId
        const call = callsById.get(callId)
        if (call && isPendingInteractionCall(call.toolCallName, callId, options)) continue
        items.push(createToolCompletedEventProcessItem(event, call))
        continue
      }

      if (event.type === 'run.failed' || event.type === 'run.timed_out') {
        items.push(createEventProcessItem({
          id: `process-${event.eventId}`,
          label: `Run failed: ${shortText(String(event.error.message || uiText.process.unknownError), 72)}`,
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
        const hasInteraction = processGroup.items.some(
          (item) => item.kind === 'tool-step' && (item.renderer === 'ask-user' || Boolean(item.approvals?.length)),
        )
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
          collapsed: options.processCollapsed.value[groupId] ?? (!isCurrentTurn && !hasInteraction),
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
          if (isPendingInteractionCall(toolCall.name, toolCall.id, options)) continue
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
  return Number.isFinite(event.timestamp) ? event.timestamp : 0
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
  const persistedToolCallIds = new Set(
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
    if (item.toolCallId && persistedToolCallIds.has(item.toolCallId)) continue

    const comparableRaw = normalizeComparableText(item.raw || '')
    if (item.kind === 'reasoning' && comparableRaw && seenReasoning.has(comparableRaw)) continue
    if (item.kind !== 'event' && comparableRaw && seenRaw.has(comparableRaw)) continue

    merged.push(item)
    if (comparableRaw) seenRaw.add(comparableRaw)
    if (item.kind === 'reasoning' && comparableRaw) seenReasoning.add(comparableRaw)
  }

  return merged
}

function normalizeComparableText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function createToolCreatedEventProcessItem(event: ToolCreatedEvent): ProcessItem {
  const name = event.toolCallName
  const description = describeToolCall(name, {})
  const callId = event.toolCallId

  return {
    id: `process-tool-call-event-${event.eventId}`,
    kind: 'tool-call',
    title: name || uiText.tool.unknownTool,
    detail: description.objectLabel,
    tone: 'neutral',
    time: parseEventTime(event),
    actionLabel: description.actionLabel,
    objectLabel: description.objectLabel,
    renderer: description.renderer,
    summary: description.summary,
    toolCategory: description.toolCategory,
    toolCallId: callId,
  }
}

function createToolReadyEventProcessItem(event: ToolReadyEvent): ProcessItem {
  return {
    id: `process-tool-args-event-${event.eventId}`,
    kind: 'tool-args',
    title: uiText.tool.input,
    detail: '',
    tone: 'neutral',
    time: parseEventTime(event),
    raw: event.delta,
    toolCallId: event.toolCallId,
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
    approvals: message.role === 'tool' ? message.approvals : undefined,
  }
}

function isPendingInteractionCall(
  toolName: string,
  callId: string,
  options: Pick<UseConversationDisplayOptions, 'pendingAsk' | 'pendingApproval'>,
) {
  if (toolName === 'ask_user' && options.pendingAsk.value?.call_id === callId) return true
  return options.pendingApproval.value?.call_id === callId
}

function createToolCompletedEventProcessItem(event: ToolCompletedEvent, callEvent?: ToolCreatedEvent): ProcessItem {
  const output = event.output ?? event.content
  const toolName = event.toolName || callEvent?.toolCallName || 'tool'
  const parsedOutput = typeof output === 'string' ? parseToolContent(output) : output
  const detail =
    event.type === 'tool_result.failed'
      ? summarizeToolFailure(parsedOutput, toolName)
      : typeof parsedOutput === 'string'
        ? parsedOutput
        : summarizeOutput(toRecord(parsedOutput))
  const raw = typeof parsedOutput === 'string' ? parsedOutput : formatJson(parsedOutput)

  return {
    id: `process-tool-result-event-${event.eventId}`,
    kind: 'tool-result',
    title: toolName,
    detail: shortText(detail, 160),
    tone: event.type === 'tool_result.failed' ? 'error' : 'neutral',
    actionLabel: event.type === 'tool_result.failed' ? uiText.process.failed : uiText.process.validationResult,
    time: parseEventTime(event),
    objectLabel: shortText(detail, 120),
    raw,
    toolCallId: event.toolCallId,
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
