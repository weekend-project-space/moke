import { ReActAgent } from '@moke/agent-re-act';
import { RunManager, ToolRegistry, type RuntimeContentManager, type RuntimeRun } from '@moke/agent-runtime';
import { LocalSystemBackend, registerAgentTools } from '@moke/agent-tools';
import {
  ContentManager,
  createActivateSkillTool,
  SkillLoader,
} from '@moke/agent-skills';
import { registerBrowserTools } from '@moke/browser-tools';
import type { ChatModelSettings } from '@moke/agent-re-act';
import { BrowserBridge, BrowserBridgeBackend } from '../services/browser-bridge.js';
import type { ImageAttachment, ResolvedImageAttachment, Session } from '@moke/protocol';

export function createToolRegistry(workspace: string, browserBridge: BrowserBridge) {
  const system = new LocalSystemBackend(workspace);
  const browserBackend = new BrowserBridgeBackend(browserBridge);
  const skillLoader = new SkillLoader(workspace);
  const toolRegistry = new ToolRegistry()
    .register(createActivateSkillTool(skillLoader));

  registerAgentTools(toolRegistry, system);
  registerBrowserTools(toolRegistry, browserBackend);

  return {
    system,
    toolRegistry,
    createSkillContentManager: async () => new ContentManager({ catalog: await skillLoader.list() }),
  };
}

export function createRunManager(input: {
  runs: Map<string, RuntimeRun>;
  toolRegistry: ToolRegistry;
  createSkillContentManager: () => RuntimeContentManager | Promise<RuntimeContentManager>;
  workspace: string;
  approveWorkspaceRoot: (root: string, scope: 'once' | 'session' | 'persistent') => (() => void) | void;
  getModelSettings: () => Partial<ChatModelSettings>;
  resolveImageAttachments: (
    attachments: ImageAttachment[],
  ) => ResolvedImageAttachment[] | Promise<ResolvedImageAttachment[]>;
  onSessionChanged: (session: Session) => void;
}) {
  return new RunManager({
    runs: input.runs,
    agent: new ReActAgent({ getModelSettings: input.getModelSettings }),
    toolRegistry: input.toolRegistry,
    workspace: input.workspace,
    createSkillContentManager: input.createSkillContentManager,
    approveWorkspaceRoot: input.approveWorkspaceRoot,
    resolveImageAttachments: input.resolveImageAttachments,
    onSessionChanged: input.onSessionChanged,
  });
}
