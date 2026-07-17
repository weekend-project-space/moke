import type {
  AgentEvent as ProtocolAgentEvent,
  AgentStep as ProtocolAgentStep,
  AgentStepPhase as ProtocolAgentStepPhase,
  ImageAttachment as ProtocolImageAttachment,
  ImageAttachmentUpload as ProtocolImageAttachmentUpload,
  PendingApproval as ProtocolPendingApproval,
  PendingAsk as ProtocolPendingAsk,
  ReasoningEffort as ProtocolReasoningEffort,
  SessionSummary as ProtocolSessionSummary,
  ToolCall as ProtocolToolCall,
  ToolApprovalRecord as ProtocolToolApprovalRecord,
} from '@moke/protocol'

export type AgentEvent = ProtocolAgentEvent
export type AgentStepPhase = ProtocolAgentStepPhase
export type AgentStep = ProtocolAgentStep
export type ReasoningEffort = ProtocolReasoningEffort
export type StoredImageAttachment = ProtocolImageAttachment
export type ImageAttachment = ProtocolImageAttachmentUpload
export type MessageImageAttachment = StoredImageAttachment | ImageAttachment
export type SessionSummary = ProtocolSessionSummary
export type PendingAsk = ProtocolPendingAsk
export type PendingApproval = ProtocolPendingApproval
export type ToolApprovalRecord = ProtocolToolApprovalRecord
export type AskOption = PendingAsk['options'][number]

type BaseMessage = {
  id?: string
  content: string
  created_at?: string
}

export type UserMessage = BaseMessage & {
  role: 'user'
  attachments?: MessageImageAttachment[]
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
  tool_calls?: ProtocolToolCall[]
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
  approvals?: ToolApprovalRecord[]
}

export type Message = UserMessage | AssistantMessage | ToolMessage
