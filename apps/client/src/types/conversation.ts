import type {
  AgentEvent as ProtocolAgentEvent,
  AgentStep as ProtocolAgentStep,
  AgentStepPhase as ProtocolAgentStepPhase,
  ImageAttachment as ProtocolImageAttachment,
  PendingApproval as ProtocolPendingApproval,
  PendingAsk as ProtocolPendingAsk,
  ReasoningEffort as ProtocolReasoningEffort,
  SessionSummary as ProtocolSessionSummary,
} from '../../../../packages/protocol/src/index'

export type AgentEvent = ProtocolAgentEvent
export type AgentStepPhase = ProtocolAgentStepPhase
export type AgentStep = ProtocolAgentStep
export type ReasoningEffort = ProtocolReasoningEffort

type BaseMessage = {
  id?: string
  content: string
  created_at?: string
}

export type UserMessage = BaseMessage & {
  role: 'user'
  attachments?: ImageAttachment[]
  reasoning?: never
  step?: never
  tool_calls?: never
  tool_call_id?: never
  name?: never
  status?: never
}

export type AssistantMessage = BaseMessage & {
  role: 'assistant'
  reasoning?: string
  step?: AgentStep
  tool_calls?: Array<{
    id: string
    name: string
    args: Record<string, unknown>
  }>
  attachments?: never
  tool_call_id?: never
  name?: never
  status?: never
}

export type ToolMessage = BaseMessage & {
  role: 'tool'
  reasoning?: never
  step?: never
  attachments?: never
  tool_calls?: never
  tool_call_id?: string
  name?: string
  status?: 'success' | 'error'
}

export type Message = UserMessage | AssistantMessage | ToolMessage

export type ImageAttachment = ProtocolImageAttachment
export type SessionSummary = ProtocolSessionSummary
export type PendingAsk = ProtocolPendingAsk
export type PendingApproval = ProtocolPendingApproval
export type AskOption = PendingAsk['options'][number]

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

export type ProcessViewItem = ProcessItem | ToolStepViewItem

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
