import type { ServerResponse } from 'node:http';

export type RiskLevel = 'safe' | 'write' | 'dangerous';

export type RunStatus =
  | 'queued'
  | 'running'
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

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
};

export type Session = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  metadata: Record<string, unknown>;
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
};

export type RuntimeLimits = {
  max_steps: number;
  max_tool_calls: number;
  timeout_ms: number;
};
