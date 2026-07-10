import type { Message } from '../model/conversation'

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
  | { type: 'time'; id: string; label: string }
  | { type: 'message'; id: string; message: Message }
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
