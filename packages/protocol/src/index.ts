export type RiskLevel = 'safe' | 'write' | 'dangerous';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

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
  type: AgentEventType;
  run_id: string;
  session_id: string;
  ts: string;
} & AgentEventPayloadUnion;

export type AgentEventType = keyof AgentEventPayloadMap;

export type AgentMessageDeltaChannel = 'answer' | 'reasoning';

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ImageAttachment = {
  id: string;
  kind: 'image';
  name?: string;
  mime_type: string;
  data_url: string;
};

export type UserMessage = {
  id: string;
  role: 'user';
  content: string;
  created_at: string;
  attachments?: ImageAttachment[];
};

export type AssistantMessage = {
  id: string;
  role: 'assistant';
  content: string;
  created_at: string;
  reasoning?: string;
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

export type SessionSummary = Omit<Session, 'messages' | 'metadata'> & {
  archived: boolean;
  pinned: boolean;
  preview: string;
  message_count: number;
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

export type RunSnapshot = {
  id: string;
  session_id: string;
  status: RunStatus;
  seq: number;
  events: AgentEvent[];
  pending_ask?: PendingAsk;
  pending_approval?: PendingApproval;
};

export type Run = RunSnapshot;

export type RuntimeLimits = {
  max_steps: number;
  max_tool_calls: number;
  timeout_ms: number;
};

export type AgentEventPayloadMap = {
  'agent.started': {
    input: string;
  };
  'agent.plan': {
    mode: string;
    planner: string;
    model: string;
    tools: string[];
  };
  'agent.state': {
    state: 'reason' | 'act' | 'respond' | string;
  };
  'agent.message.delta': {
    channel?: AgentMessageDeltaChannel;
    content: string;
  };
  'agent.message.done': {
    message: Message;
  };
  'tool.call': {
    call_id: string;
    tool: string;
    input: Record<string, unknown>;
    risk: RiskLevel;
    source?: {
      type: 'local' | 'mcp';
      server_id?: string;
    };
  };
  'tool.result': {
    call_id: string;
    status: 'ok' | 'error' | string;
    duration_ms: number;
    output: unknown;
  };
  'ask_user.required': PendingAsk;
  'approval.required': PendingApproval;
  'agent.done': {
    status: RunStatus;
    usage?: {
      steps: number;
      tool_calls: number;
      duration_ms: number;
    };
  };
  'agent.error': {
    code: string;
    message: string;
  };
};

type AgentEventPayloadUnion = {
  [Type in AgentEventType]: {
    type: Type;
    payload: AgentEventPayloadMap[Type];
  };
}[AgentEventType];
