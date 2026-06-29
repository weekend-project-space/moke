import { ReActAgent } from '../../../packages/agent-re-act/src/index.js';
import { RunManager, ToolRegistry } from '../../../packages/agent-runtime/src/index.js';
import { LocalSystemBackend, registerAgentTools } from '../../../packages/agent-tools/src/index.js';
import {
  ContentManager,
  createListSkillsTool,
  createReadSkillTool,
  SkillLoader,
} from '../../../packages/agent-skills/src/index.js';
import { registerBrowserTools } from '../../../packages/browser-tools/src/index.js';
import type { Run, Session } from '../../../packages/protocol/src/index.js';
import { BrowserBridge, BrowserBridgeBackend } from '../services/browser-bridge.js';

export function createToolRegistry(workspace: string, browserBridge: BrowserBridge) {
  const system = new LocalSystemBackend(workspace);
  const browserBackend = new BrowserBridgeBackend(browserBridge);
  const skillLoader = new SkillLoader(workspace);
  const toolRegistry = new ToolRegistry()
    .register(createListSkillsTool(skillLoader))
    .register(createReadSkillTool(skillLoader));

  registerAgentTools(toolRegistry, system);
  registerBrowserTools(toolRegistry, browserBackend);

  return { system, toolRegistry };
}

export function createRunManager(input: {
  runs: Map<string, Run>;
  sessions: Map<string, Session>;
  toolRegistry: ToolRegistry;
  workspace: string;
  approveWorkspaceRoot: (root: string, scope: 'once' | 'session' | 'persistent') => void;
  onChange: () => void;
}) {
  return new RunManager({
    sessions: input.sessions,
    runs: input.runs,
    agent: new ReActAgent(),
    toolRegistry: input.toolRegistry,
    workspace: input.workspace,
    createSkillContentManager: () => new ContentManager(),
    approveWorkspaceRoot: input.approveWorkspaceRoot,
    onChange: input.onChange,
  });
}
