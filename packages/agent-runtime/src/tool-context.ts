export type RuntimeContentManager = {
  addSkill: (skill: { name: string; description: string; path: string; content: string }) => void;
  buildContext: () => string;
  reset?: () => void;
};

export type WorkspacePathApprovalRequest = {
  tool: string;
  input: Record<string, unknown>;
  risk: 'safe' | 'write' | 'dangerous';
  source?: {
    type: 'local' | 'mcp';
    server_id?: string;
  };
  callId?: string;
  path: string;
  suggestedRoot: string;
  reason?: string;
};

export type WorkspacePathApprovalDecision = {
  approved: boolean;
  scope?: 'once' | 'session' | 'persistent';
  message?: string;
  cleanup?: () => void;
};

export type ToolContext = {
  workspace: string;
  abortSignal?: AbortSignal;
  contentManager?: RuntimeContentManager;
  currentToolCall?: {
    callId: string;
    tool: string;
    input: Record<string, unknown>;
    risk: 'safe' | 'write' | 'dangerous';
  };
  askUser?: (input: {
    callId: string;
    question: string;
    options: Array<{ id: string; label: string }>;
  }) => Promise<{ id: string; label: string }>;
  approveWorkspacePath?: (input: WorkspacePathApprovalRequest) => Promise<WorkspacePathApprovalDecision>;
};
