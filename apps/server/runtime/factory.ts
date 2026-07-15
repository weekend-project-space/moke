import { ReActAgent } from '@moke/agent-re-act';
import { RunManager, ToolRegistry, type RuntimeRun } from '@moke/agent-runtime';
import { LocalSystemBackend, registerAgentTools } from '@moke/agent-tools';
import {
  ContentManager,
  createListSkillsTool,
  createReadSkillTool,
  SkillLoader,
} from '@moke/agent-skills';
import { registerBrowserTools } from '@moke/browser-tools';
import type { ChatModelSettings } from '@moke/agent-re-act';
import type { Session } from '@moke/protocol';
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
  runs: Map<string, RuntimeRun>;
  sessions: Map<string, Session>;
  toolRegistry: ToolRegistry;
  workspace: string;
  approveWorkspaceRoot: (root: string, scope: 'once' | 'session' | 'persistent') => (() => void) | void;
  getModelSettings: () => Partial<ChatModelSettings>;
  onChange: () => void;
}) {
  return new RunManager({
    sessions: input.sessions,
    runs: input.runs,
    agent: new ReActAgent({ getModelSettings: input.getModelSettings }),
    toolRegistry: input.toolRegistry,
    workspace: input.workspace,
    createSkillContentManager: () => new ContentManager(),
    approveWorkspaceRoot: input.approveWorkspaceRoot,
    onChange: input.onChange,
  });
}
