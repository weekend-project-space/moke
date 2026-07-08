export type AgentEvent = {
  id: string
  seq: number
  type: string
  ts: string
  payload: Record<string, any>
}

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'ultra'

export type Message = {
  id?: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  created_at?: string
  attachments?: ImageAttachment[]
  tool_calls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
  tool_call_id?: string
  name?: string
  status?: 'success' | 'error'
}

export type ImageAttachment = {
  id: string
  kind: 'image'
  name?: string
  mime_type: string
  data_url: string
}

export type SessionSummary = {
  id: string
  title: string
  created_at: string
  updated_at: string
  archived?: boolean
  pinned?: boolean
  preview?: string
  message_count?: number
}

export type AskOption = {
  id: string
  label: string
}

export type PendingAsk = {
  ask_id: string
  call_id: string
  question: string
  options: AskOption[]
  created_at?: string
}

export type PendingApproval = {
  approval_id: string
  kind?: 'workspace_path' | 'tool'
  reason: string
  risk?: 'safe' | 'write' | 'dangerous'
  action?: {
    tool: string
    input: Record<string, unknown>
  }
  path?: string
  suggested_root?: string
  created_at?: string
}

export type TraceStep = {
  id: string
  kind: string
  title: string
  detail: string
}

export type ProcessTone = 'neutral' | 'error' | 'ask'
export type ToolCategory = 'view' | 'change' | 'run'
export type ToolRendererKind = 'file-read' | 'file-change' | 'directory' | 'search' | 'command' | 'browser' | 'generic'

export type ToolStepSummary = {
  command?: string
  count?: number
  cwd?: string
  exitCode?: number
  files?: string[]
  path?: string
  preview?: string
  query?: string
  stderr?: string
  stdout?: string
  url?: string
  uid?: string
  value?: string
}

export type ProcessNote = {
  id: string
  label: string
  raw?: string
  tone: ProcessTone
  time: number
}

export type ProcessItem = {
  id: string
  kind: 'assistant' | 'tool-call' | 'tool-result' | 'event' | 'reasoning'
  title: string
  detail: string
  tone: ProcessTone
  time?: number
  actionLabel?: string
  objectLabel?: string
  renderer?: ToolRendererKind
  summary?: ToolStepSummary
  toolCategory?: ToolCategory
  raw?: string
  toolCallId?: string
}

export type ToolStepViewItem = {
  id: string
  kind: 'tool-step'
  title: string
  detail: string
  tone: ProcessTone
  time?: number
  toolName: string
  actionLabel: string
  objectLabel: string
  renderer: ToolRendererKind
  summary: ToolStepSummary
  toolCategory: ToolCategory
  inputRaw?: string
  outputRaw?: string
}

export type ToolBatchViewItem = {
  id: string
  kind: 'tool-batch'
  title: string
  detail: string
  tone: ProcessTone
  time?: number
  actionLabel: string
  objectLabel: string
  countLabel: string
  renderer: ToolRendererKind
  toolCategory: ToolCategory
  steps: ToolStepViewItem[]
}

export type ProcessViewItem = ProcessItem | ToolStepViewItem | ToolBatchViewItem

export type ProcessGroupView = {
  label: string
  items: ProcessViewItem[]
  hasError: boolean
  startedAt?: number
  endedAt?: number
}

export type TaskTemplate = {
  title: string
  description: string
  prompt: string
}

export type DisplayItem =
  | {
      type: 'time'
      id: string
      label: string
    }
  | {
      type: 'message'
      id: string
      message: Message
    }
  | {
      type: 'process-group'
      id: string
      label: string
      items: ProcessViewItem[]
      collapsed: boolean
      hasError: boolean
      startedAt?: number
      endedAt?: number
      isActive?: boolean
    }
