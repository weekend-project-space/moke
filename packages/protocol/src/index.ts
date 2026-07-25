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

export type RunLifecycleEvent = {
  type: RunStatus;
  sessionId: string;
  runId: string;
};

export type AgentEvent = {
  id: string;
  seq: number;
  type: AgentEventType;
  run_id: string;
  session_id: string;
  ts: string;
  step?: AgentStep;
} & AgentEventPayloadUnion;

export type AgentEventType = keyof AgentEventPayloadMap;

export type AgentMessageDeltaChannel = 'answer' | 'reasoning';

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  uncached_input_tokens?: number;
};

export type AgentStepPhase = 'reason' | 'act' | 'respond';

export type AgentStep = {
  index: number;
  phase: AgentStepPhase;
};

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
  relative_path: string;
  size: number;
  sha256: string;
};

export type ImageAttachmentUpload = {
  id: string;
  kind: 'image';
  name?: string;
  mime_type: string;
  data_url: string;
};

export type ResolvedImageAttachment = ImageAttachment & {
  data_url: string;
};

export type UserMessage = {
  id: string;
  role: 'user';
  content: string;
  created_at: string;
  /** Internal context is retained for the model but not rendered in the conversation. */
  visibility?: 'public' | 'internal';
  attachments?: ImageAttachment[];
  source?: {
    kind: 'messaging';
    platform: string;
    connection_id: string;
    message_id: string;
  };
};

export type AssistantMessage = {
  id: string;
  role: 'assistant';
  content: string;
  created_at: string;
  step?: AgentStep;
  reasoning?: string;
  tool_calls?: ToolCall[];
};

export type ToolApprovalRecord = {
  approval_id: string;
  kind: 'workspace_path' | 'tool';
  decision: 'approved' | 'rejected';
  scope: 'once' | 'session' | 'persistent';
  reason: string;
};

export type ToolMessage = {
  id: string;
  role: 'tool';
  content: string;
  created_at: string;
  tool_call_id: string;
  name: string;
  status?: 'success' | 'error';
  approvals?: ToolApprovalRecord[];
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
  call_id?: string;
  kind: 'workspace_path' | 'tool';
  reason: string;
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
  'ask_user.answered': {
    ask_id: string;
    call_id: string;
    selected: {
      id: string;
      label: string;
    };
  };
  'approval.required': PendingApproval;
  'approval.resolved': {
    approval_id: string;
    decision: 'approved' | 'rejected';
    scope: 'once' | 'session' | 'persistent';
  };
  'agent.done': {
    status: RunStatus;
    usage?: {
      steps: number;
      tool_calls: number;
      duration_ms: number;
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      uncached_input_tokens?: number;
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

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type CreateSessionRequest = {
  title?: string;
  metadata?: Record<string, unknown>;
};

export type CreateSessionResponse = {
  session: Session;
};

export type ListSessionsResponse = {
  sessions: SessionSummary[];
  next_cursor: string | null;
};

export type GetSessionResponse = {
  session: SessionSummary & Pick<Session, 'metadata'>;
  messages: Message[];
};

export type UpdateSessionRequest = {
  title?: string;
  archived?: boolean;
  pinned?: boolean;
};

export type UpdateSessionResponse = {
  session: SessionSummary;
};

export type ForkSessionRequest = {
  message_id: string;
  mode?: 'after';
};

export type ForkSessionResponse = GetSessionResponse;

export type SendMessageRequest = {
  message: {
    role?: 'user';
    content: string;
    attachments?: ImageAttachmentUpload[];
  };
  options?: {
    stream?: boolean;
    max_steps?: number;
    max_tool_calls?: number;
    timeout_ms?: number;
    reasoningEffort?: ReasoningEffort;
  };
};

export type SendMessageResponse = {
  run_id: string;
  session_id: string;
  events_url: string;
};

export type ActiveRunSummary = {
  session_id: string;
  run_id: string;
  status: RunStatus;
  events_url: string;
  pending_ask?: PendingAsk;
  pending_approval?: PendingApproval;
};

export type ListActiveRunsResponse = {
  runs: ActiveRunSummary[];
};

export type GetRunResponse = {
  run: RunSnapshot;
};

export type RespondToRunRequest =
  | { type: 'choose'; request_id: string; option_id: string }
  | {
      type: 'approve';
      request_id: string;
      decision: 'approved' | 'rejected';
      scope?: 'once' | 'session' | 'persistent';
      message?: string;
    }
  | { type: 'cancel'; reason?: string };

export type RespondToRunResponse = {
  run_id: string;
  request_id?: string;
  status: RunStatus;
};
