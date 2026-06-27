export type AgentEvent = {
  id: string
  seq: number
  type: string
  ts: string
  payload: Record<string, any>
}

export type Message = {
  role: 'user' | 'assistant' | 'tool'
  content: string
  created_at?: string
  tool_calls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
  tool_call_id?: string
  name?: string
  status?: 'success' | 'error'
}

export type SessionSummary = {
  id: string
  title: string
  created_at: string
  updated_at: string
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

export type TraceStep = {
  id: string
  kind: string
  title: string
  detail: string
}

export type ProcessTone = 'neutral' | 'error' | 'ask'
export type ToolCategory = 'workspace' | 'browser' | 'skill' | 'command' | 'tool'
export type ToolRisk = 'safe' | 'write' | 'dangerous'

export type ProcessNote = {
  id: string
  label: string
  tone: ProcessTone
  time: number
}

export type ProcessItem = {
  id: string
  kind: 'assistant' | 'tool-call' | 'tool-result' | 'event'
  title: string
  detail: string
  tone: ProcessTone
  actionLabel?: string
  objectLabel?: string
  toolCategory?: ToolCategory
  toolRisk?: ToolRisk
  raw?: string
  toolCallId?: string
}

export type ToolStepViewItem = {
  id: string
  kind: 'tool-step'
  title: string
  detail: string
  tone: ProcessTone
  toolName: string
  actionLabel: string
  objectLabel: string
  toolCategory: ToolCategory
  toolRisk: ToolRisk
  inputRaw?: string
  outputRaw?: string
}

export type ToolBatchViewItem = {
  id: string
  kind: 'tool-batch'
  title: string
  detail: string
  tone: ProcessTone
  actionLabel: string
  objectLabel: string
  countLabel: string
  toolCategory: ToolCategory
  toolRisk: ToolRisk
  steps: ToolStepViewItem[]
}

export type ProcessViewItem = ProcessItem | ToolStepViewItem | ToolBatchViewItem

export type ProcessGroupView = {
  label: string
  items: ProcessViewItem[]
  hasError: boolean
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
    }
