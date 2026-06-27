import type { ServerResponse } from 'node:http';

export type RiskLevel = 'safe' | 'write' | 'dangerous';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_user'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export type AgentEvent = {
  id: string;
  seq: number;
  type: string;
  run_id: string;
  session_id: string;
  ts: string;
  payload: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type UserMessage = {
  id: string;
  role: 'user';
  content: string;
  created_at: string;
};

export type AssistantMessage = {
  id: string;
  role: 'assistant';
  content: string;
  created_at: string;
  tool_calls?: ToolCall[];
};

export type ToolMessage = {
  id: string;
  role: 'tool';
  content: string;
  created_at: string;
  tool_call_id: string;
  name: string;
  status?: 'success' | 'error';
};

export type Message = UserMessage | AssistantMessage | ToolMessage;

export type Session = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  metadata: Record<string, unknown>;
};

export type PendingAsk = {
  ask_id: string;
  call_id: string;
  question: string;
  options: Array<{
    id: string;
    label: string;
  }>;
  created_at: string;
};

export type PendingApproval = {
  approval_id: string;
  kind: 'workspace_path' | 'tool';
  reason: string;
  risk: RiskLevel;
  action: {
    tool: string;
    input: Record<string, unknown>;
  };
  path?: string;
  suggested_root?: string;
  created_at: string;
};

export type Run = {
  id: string;
  session_id: string;
  status: RunStatus;
  seq: number;
  events: AgentEvent[];
  clients: Set<ServerResponse>;
  started_at: number;
  abort: boolean;
  pending_ask?: PendingAsk;
  pending_approval?: PendingApproval;
};

export type RuntimeLimits = {
  max_steps: number;
  max_tool_calls: number;
  timeout_ms: number;
};
