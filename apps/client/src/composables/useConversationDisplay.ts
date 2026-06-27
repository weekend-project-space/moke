import { computed, type Ref } from 'vue'
import type {
  AgentEvent,
  DisplayItem,
  Message,
  PendingAsk,
  ProcessGroupView,
  ProcessItem,
  ProcessNote,
  ProcessViewItem,
  ToolCategory,
  ToolRisk,
  ToolStepViewItem,
} from '../types/conversation'

const MESSAGE_TIME_GAP_MS = 10 * 60 * 1000

type ToolDescriptor = {
  actionLabel: string
  category: ToolCategory
  risk: ToolRisk
}

const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  active_skill: { actionLabel: '启用能力', category: 'skill', risk: 'safe' },
  click: { actionLabel: '点击页面元素', category: 'browser', risk: 'safe' },
  close_page: { actionLabel: '关闭标签页', category: 'browser', risk: 'safe' },
  create_page: { actionLabel: '新建标签页', category: 'browser', risk: 'safe' },
  edit_file: { actionLabel: '修改文件', category: 'workspace', risk: 'write' },
  evaluate_script: { actionLabel: '执行页面脚本', category: 'browser', risk: 'safe' },
  execute: { actionLabel: '执行命令', category: 'command', risk: 'dangerous' },
  fill: { actionLabel: '填写输入框', category: 'browser', risk: 'safe' },
  fill_form: { actionLabel: '填写表单', category: 'browser', risk: 'safe' },
  glob: { actionLabel: '查找文件', category: 'workspace', risk: 'safe' },
  grep: { actionLabel: '搜索内容', category: 'workspace', risk: 'safe' },
  handle_dialog: { actionLabel: '处理弹窗', category: 'browser', risk: 'safe' },
  hide_browser: { actionLabel: '隐藏浏览器', category: 'browser', risk: 'safe' },
  hover: { actionLabel: '悬停页面元素', category: 'browser', risk: 'safe' },
  list_pages: { actionLabel: '查看标签页', category: 'browser', risk: 'safe' },
  list_skills: { actionLabel: '查看能力', category: 'skill', risk: 'safe' },
  ls: { actionLabel: '浏览目录', category: 'workspace', risk: 'safe' },
  navigate_page: { actionLabel: '导航网页', category: 'browser', risk: 'safe' },
  press_key: { actionLabel: '发送按键', category: 'browser', risk: 'safe' },
  read_file: { actionLabel: '读取文件', category: 'workspace', risk: 'safe' },
  resize_page: { actionLabel: '调整页面尺寸', category: 'browser', risk: 'safe' },
  search: { actionLabel: '搜索项目', category: 'workspace', risk: 'safe' },
  select_page: { actionLabel: '切换标签页', category: 'browser', risk: 'safe' },
  show_browser: { actionLabel: '显示浏览器', category: 'browser', risk: 'safe' },
  take_screenshot: { actionLabel: '截取页面', category: 'browser', risk: 'safe' },
  take_snapshot: { actionLabel: '读取页面结构', category: 'browser', risk: 'safe' },
  type_text: { actionLabel: '输入文本', category: 'browser', risk: 'safe' },
  upload_file: { actionLabel: '上传文件', category: 'browser', risk: 'write' },
  wait_for: { actionLabel: '等待页面变化', category: 'browser', risk: 'safe' },
  write_file: { actionLabel: '创建文件', category: 'workspace', risk: 'write' },

  apply_patch: { actionLabel: '修改文件', category: 'workspace', risk: 'write' },
  bash: { actionLabel: '执行命令', category: 'command', risk: 'dangerous' },
  cat: { actionLabel: '读取文件', category: 'workspace', risk: 'safe' },
  exec_command: { actionLabel: '执行命令', category: 'command', risk: 'dangerous' },
  find: { actionLabel: '搜索内容', category: 'workspace', risk: 'safe' },
  npm: { actionLabel: '执行命令', category: 'command', risk: 'dangerous' },
  rg: { actionLabel: '搜索内容', category: 'workspace', risk: 'safe' },
  sed: { actionLabel: '读取文件', category: 'workspace', risk: 'safe' },
  shell_command: { actionLabel: '执行命令', category: 'command', risk: 'dangerous' },
  view_image: { actionLabel: '查看图片', category: 'workspace', risk: 'safe' },
}

type UseConversationDisplayOptions = {
  messages: Ref<Message[]>
  events: Ref<AgentEvent[]>
  isRunning: Ref<boolean>
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
        items.push({
          type: 'process-group',
          id: groupId,
          label: processGroup.label,
          items: processGroup.items,
          collapsed: options.processCollapsed.value[groupId] ?? true,
          hasError: processGroup.hasError,
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
      items.push({
        type: 'process-group',
        id: groupId,
        label: processGroup.label,
        items: processGroup.items,
        collapsed: options.processCollapsed.value[groupId] ?? true,
        hasError: processGroup.hasError,
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

export function summarizeOutput(output: Record<string, any> | undefined) {
  if (!output) return '已完成'
  if (output.error) return String(output.error)

  if (Array.isArray(output.matches)) {
    const count = output.count ?? output.matches.length
    return count > 0 ? `找到 ${count} 条相关内容` : '没有找到相关内容'
  }

  return '已完成'
}

function parseEventTime(event: AgentEvent) {
  const time = Date.parse(event.ts)
  return Number.isNaN(time) ? 0 : time
}

function formatToolName(rawName: unknown, toolLabels: Record<string, string>) {
  const name = String(rawName || '').trim()
  return toolLabels[name] || name || '工具'
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value ?? '')
  }
}

function parseToolContent(content: string) {
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

function shortText(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

function firstString(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }

  return ''
}

function describeToolCall(name: string, args: Record<string, unknown>) {
  const descriptor = TOOL_DESCRIPTORS[name] || { actionLabel: '调用工具', category: 'tool' as ToolCategory, risk: 'safe' as ToolRisk }
  const command = firstString(args, ['command', 'cmd', 'script'])
  const path = firstString(args, ['path', 'file', 'filePath', 'cwd'])
  const query = firstString(args, ['query', 'pattern', 'q'])
  const pageId = firstString(args, ['pageId'])
  const uid = firstString(args, ['uid'])
  const url = firstString(args, ['url'])
  const text = firstString(args, ['text'])
  const value = firstString(args, ['value'])
  const key = firstString(args, ['key'])
  const selector = firstString(args, ['selector'])
  let actionLabel = descriptor.actionLabel
  let objectLabel = name

  switch (name) {
    case 'apply_patch':
      objectLabel = path ? shortText(path, 88) : '应用代码补丁'
      break
    case 'write_file':
    case 'edit_file':
    case 'read_file':
    case 'cat':
    case 'sed':
      objectLabel = path ? shortText(path, 88) : '文件内容'
      break
    case 'execute':
    case 'shell_command':
    case 'exec_command':
    case 'bash':
    case 'npm':
      objectLabel = command ? shortText(command, 96) : name
      break
    case 'glob':
    case 'grep':
    case 'search':
    case 'rg':
    case 'find':
      objectLabel = shortText(query || path || '在项目中查找', 88)
      break
    case 'ls':
      objectLabel = path ? shortText(path, 88) : '查看文件列表'
      break
    case 'view_image':
      objectLabel = path ? shortText(path, 88) : '打开本地图片'
      break
    case 'navigate_page': {
      const type = firstString(args, ['type'])
      if (type === 'url' && url) {
        actionLabel = '打开网页'
        objectLabel = shortText(url, 96)
        break
      }
      if (type === 'back') {
        actionLabel = '浏览器返回'
        objectLabel = '上一页'
        break
      }
      if (type === 'forward') {
        actionLabel = '浏览器前进'
        objectLabel = '下一页'
        break
      }
      if (type === 'reload') {
        actionLabel = '刷新网页'
        objectLabel = '当前页面'
        break
      }
      objectLabel = url ? shortText(url, 96) : '浏览器页面'
      break
    }
    case 'create_page':
      objectLabel = url ? shortText(url, 96) : '新标签页'
      break
    case 'select_page':
    case 'close_page':
    case 'resize_page':
      objectLabel = pageId ? `页面 ${pageId}` : '浏览器标签页'
      break
    case 'take_snapshot':
      objectLabel = pageId ? `页面 ${pageId}` : '当前网页'
      break
    case 'take_screenshot':
      objectLabel = args.fullPage ? '完整页面' : '当前视口'
      break
    case 'click':
    case 'hover':
      objectLabel = uid ? `元素 ${uid}` : selector || '目标元素'
      break
    case 'fill':
      objectLabel = uid ? `元素 ${uid}${value ? `：${shortText(value, 48)}` : ''}` : shortText(value || '输入内容', 72)
      break
    case 'fill_form':
      objectLabel = '页面表单'
      break
    case 'upload_file':
      objectLabel = path || (uid ? `元素 ${uid}` : '选择文件')
      break
    case 'wait_for':
      objectLabel = text ? shortText(text, 72) : '目标状态出现'
      break
    case 'press_key':
      objectLabel = key || '键盘操作'
      break
    case 'type_text':
      objectLabel = text ? shortText(text, 72) : '文本内容'
      break
    case 'evaluate_script':
      objectLabel = selector ? shortText(selector, 72) : '当前页面'
      break
    case 'handle_dialog':
      objectLabel = firstString(args, ['action', 'type']) || '当前弹窗'
      break
    case 'show_browser':
    case 'hide_browser':
      objectLabel = '右侧面板'
      break
    case 'active_skill':
      objectLabel = firstString(args, ['name', 'skill']) || '能力配置'
      break
    case 'list_skills':
      objectLabel = '可用能力列表'
      break
    default:
      objectLabel = name
  }

  return {
    actionLabel,
    objectLabel,
    toolCategory: descriptor.category,
    toolRisk: descriptor.risk,
  }
}
function createAssistantProcessItem(message: Message, id: string): ProcessItem {
  return {
    id: `process-assistant-${id}`,
    kind: 'assistant',
    title: '',
    detail: shortText(message.content, 140),
    tone: 'neutral',
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
    actionLabel: description.actionLabel,
    objectLabel: description.objectLabel,
    toolCategory: description.toolCategory,
    toolRisk: description.toolRisk,
    raw: formatJson(toolCall.args),
    toolCallId: toolCall.id,
  }
}

function createToolResultProcessItem(message: Message, id: string): ProcessItem {
  const parsed = parseToolContent(message.content)
  const detail = typeof parsed === 'string' ? parsed : summarizeOutput(parsed)
  const raw = typeof parsed === 'string' ? parsed : formatJson(parsed)

  return {
    id: `process-tool-result-${id}`,
    kind: 'tool-result',
    title: message.name || 'tool',
    detail: shortText(detail, 160),
    tone: message.status === 'error' ? 'error' : 'neutral',
    actionLabel: message.status === 'error' ? '执行失败' : '校验结果',
    objectLabel: shortText(detail, 160),
    toolCategory: 'tool',
    toolRisk: 'safe',
    raw,
    toolCallId: message.tool_call_id,
  }
}

function createEventProcessItem(note: ProcessNote): ProcessItem {
  return {
    id: `process-event-${note.id}`,
    kind: 'event',
    title: note.tone === 'error' ? '运行提示' : '执行过程',
    detail: note.label,
    tone: note.tone,
    actionLabel: note.tone === 'error' ? '遇到问题' : '执行状态',
    objectLabel: note.label,
    toolCategory: 'tool',
    toolRisk: 'safe',
  }
}

function createProcessGroupView(items: ProcessItem[]): ProcessGroupView {
  const viewItems = mergeToolSteps(items)

  return {
    label: processGroupLabel(viewItems),
    items: viewItems,
    hasError: viewItems.some((item) => item.tone === 'error'),
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
        step.tone = item.tone
        step.outputRaw = item.raw
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

function createToolStepView(call: ProcessItem): ToolStepViewItem {
  return {
    id: `process-tool-step-${call.id}`,
    kind: 'tool-step',
    title: call.title,
    detail: call.detail,
    tone: call.tone,
    toolName: call.title,
    actionLabel: call.actionLabel || '调用工具',
    objectLabel: call.objectLabel || call.detail,
    toolCategory: call.toolCategory || 'tool',
    toolRisk: call.toolRisk || 'safe',
    inputRaw: call.raw,
  }
}

function processGroupLabel(items: ProcessViewItem[]) {
  const toolSteps = items.filter((item) => item.kind === 'tool-step').length
  const fallbackToolItems = items.filter((item) => item.kind === 'tool-call' || item.kind === 'tool-result').length
  const errors = items.filter((item) => item.tone === 'error').length
  const parts = ['查看执行过程']

  if (toolSteps || fallbackToolItems) parts.push(`${toolSteps || fallbackToolItems} 个步骤`)
  if (errors) parts.push(`${errors} 个失败`)
  if (parts.length === 1) parts.push(`${items.length} 条记录`)

  return parts.join(' · ')
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
