export type RuntimeContentManager = {
  addSkill: (skill: { name: string; description: string; path: string; content: string }) => void;
  buildContext: () => string;
  reset?: () => void;
};

export type ToolContext = {
  workspace: string;
  contentManager?: RuntimeContentManager;
  askUser?: (input: {
    callId: string;
    question: string;
    options: Array<{ id: string; label: string }>;
  }) => Promise<{ id: string; label: string }>;
};
