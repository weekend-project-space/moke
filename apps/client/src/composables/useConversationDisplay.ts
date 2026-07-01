import { computed, type Ref } from 'vue'
import type {
  AgentEvent,
  DisplayItem,
  Message,
  PendingAsk,
  ProcessItem,
  ProcessNote,
} from '../types/conversation'
import { createProcessGroupView, formatProcessGroupLabel } from './processDisplay'
import {
  describeToolCall,
  formatJson,
  formatToolName,
  parseToolContent,
  shortText,
  summarizeOutput,
} from './toolDisplay'

const MESSAGE_TIME_GAP_MS = 10 * 60 * 1000

type UseConversationDisplayOptions = {
  messages: Ref<Message[]>
  events: Ref<AgentEvent[]>
  isRunning: Ref<boolean>
  runtimeNow: Ref<number>
  pendingAsk: Ref<PendingAsk | null>
  pendingApproval: Ref<unknown | null>
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
  const processNotes = computed<ProcessNote[]>(() => {
    const notes: ProcessNote[] = []
    const callsById = new Map<string, AgentEvent>()
    let completedTools = 0
    let latestToolTime = 0

    for (const event of options.events.value) {
      if (event.type === 'tool.call') {
        callsById.set(String(event.payload.call_id || event.id), event)
        latestToolTime = parseEventTime(event) || latestToolTime
        continue
      }

      if (event.type === 'tool.result') {
        latestToolTime = parseEventTime(event) || latestToolTime
        if (event.payload.status === 'ok') completedTools += 1
        if (event.payload.status !== 'error') continue

        const call = callsById.get(String(event.payload.call_id || ''))
        const toolName = formatToolName(call?.payload.tool, options.toolLabels)
        notes.push({
          id: `process-${event.id}`,
          label: `工具执行失败：${toolName} · ${shortText(summarizeOutput(event.payload.output), 72)}`,
          tone: 'error',
          time: parseEventTime(event),
        })
      }

      if (event.type === 'approval.required') {
        notes.push({
          id: `process-${event.id}`,
          label: `等待确认：${shortText(String(event.payload.reason || '需要确认后继续执行'), 72)}`,
          tone: 'ask',
          time: parseEventTime(event),
        })
      }

      if (event.type === 'agent.error') {
        notes.push({
          id: `process-${event.id}`,
          label: `运行失败：${shortText(String(event.payload.message || '未知错误'), 72)}`,
          tone: 'error',
          time: parseEventTime(event),
        })
      }
    }

    const latestActivity = latestProcessActivity(
      callsById,
      completedTools,
      latestToolTime,
      options.isRunning.value,
      options.toolLabels,
    )
    if (latestActivity) notes.push(latestActivity)

    return notes.slice(-4)
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
        const groupId = `process-turn-${turnIndex}`
        const processGroup = createProcessGroupView(processItems)
        const startedAt = turnStartedAt || processGroup.startedAt
        const endedAt = turnEndedAt || processGroup.endedAt || startedAt
        items.push({
          type: 'process-group',
          id: groupId,
          label: formatProcessGroupLabel({ ...processGroup, startedAt, endedAt }, false, options.runtimeNow.value),
          items: processGroup.items,
          collapsed: options.processCollapsed.value[groupId] ?? true,
          hasError: processGroup.hasError,
          startedAt,
          endedAt,
          isActive: false,
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
        if (message.content.trim()) processItems.push(createAssistantProcessItem(message, `message-${index}`))
        for (const toolCall of message.tool_calls) {
          processItems.push(createToolCallProcessItem(toolCall, `message-${index}-${toolCall.id}`))
        }
        return
      }

      if (message.content.trim()) {
        movePendingFinalToProcess()
        pendingFinalMessage = { id: `message-${index}`, message }
        if (time) turnEndedAt = time
      }
    })

    flushAssistantTurn()

    if (
      (options.isRunning.value || options.pendingAsk.value || options.pendingApproval.value || options.runError.value) &&
      processNotes.value.length
    ) {
      const groupId = 'process-current-events'
      const itemsFromEvents = processNotes.value.map(createEventProcessItem)
      const processGroup = createProcessGroupView(itemsFromEvents)
      const startedAt = latestUserMessageTime(sourceMessages) || processGroup.startedAt
      const endedAt = options.isRunning.value ? options.runtimeNow.value : processGroup.endedAt || startedAt
      const previousProcessIndex = findPreviousProcessGroupIndex(items)
      if (previousProcessIndex >= 0) items.splice(previousProcessIndex, 1)
      items.push({
        type: 'process-group',
        id: groupId,
        label: formatProcessGroupLabel({ ...processGroup, startedAt, endedAt }, options.isRunning.value, options.runtimeNow.value),
        items: processGroup.items,
        collapsed: options.processCollapsed.value[groupId] ?? true,
        hasError: processGroup.hasError,
        startedAt,
        endedAt,
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
    processNotes,
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

function findPreviousProcessGroupIndex(items: DisplayItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.type === 'message' && item.message.role === 'user') return -1
    if (item.type === 'process-group') return index
  }

  return -1
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
    actionLabel: message.status === 'error' ? '执行失败' : '校验结果',
    time: parseMessageTime(message),
    objectLabel: shortText(detail, 120),
    renderer: 'generic',
    summary: {},
    toolCategory: 'run',
    raw,
    toolCallId: message.tool_call_id,
  }
}

function summarizeToolFailure(parsed: unknown, fallbackName?: string) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const error = (parsed as Record<string, any>).error
    if (error && typeof error === 'object') {
      const tool = typeof error.tool === 'string' ? error.tool : fallbackName
      const path = typeof error.path === 'string' ? error.path : ''
      const message = typeof error.message === 'string' ? error.message : ''
      const target = path || extractPathFromErrorMessage(message)
      return target ? `${tool || '工具'} · ${target}` : `${tool || '工具'}执行失败`
    }
  }

  return fallbackName ? `${fallbackName}执行失败` : '工具执行失败'
}

function extractPathFromErrorMessage(message: string) {
  const quoted = message.match(/'([^']+)'/)
  if (quoted?.[1]) return quoted[1]

  const windowsPath = message.match(/[a-zA-Z]:\\[^\s,)]+/)
  return windowsPath?.[0] || ''
}

function createEventProcessItem(note: ProcessNote): ProcessItem {
  return {
    id: `process-event-${note.id}`,
    kind: 'event',
    title: note.tone === 'error' ? '运行提示' : '执行过程',
    detail: note.label,
    tone: note.tone,
    actionLabel: note.tone === 'error' ? '遇到问题' : '执行状态',
    time: note.time,
    objectLabel: note.label,
    renderer: 'generic',
    summary: { preview: note.label },
    toolCategory: 'run',
  }
}

function latestProcessActivity(
  callsById: Map<string, AgentEvent>,
  completedTools: number,
  time: number,
  isRunning: boolean,
  toolLabels: Record<string, string>,
): ProcessNote | null {
  const calls = [...callsById.values()]
  const latestCall = calls.at(-1)

  if (isRunning && latestCall) {
    const toolName = formatToolName(latestCall.payload.tool, toolLabels)
    return {
      id: `process-active-${latestCall.id}`,
      label: `正在${toolName}`,
      tone: 'neutral',
      time: time || parseEventTime(latestCall),
    }
  }

  if (completedTools > 0) {
    return {
      id: 'process-completed-tools',
      label: `已完成 ${completedTools} 个步骤`,
      tone: 'neutral',
      time,
    }
  }

  return null
}
