import path from 'node:path';

import { RunManager, ToolRegistry, type RuntimeContentManager, type RuntimeRun, type WorkspacePathApprovalDecision } from '@moke/agent-runtime';
import { LocalSystemBackend, registerAgentTools } from '@moke/agent-tools';
import {
  ContentManager,
  createActivateSkillTool,
  SkillLoader,
} from '@moke/agent-skills';
import { registerBrowserTools } from '@moke/browser-tools';
import { BrowserBridge, BrowserBridgeBackend } from '../services/browser-bridge.js';
import type { ChatModelSettings } from '../storage/settings.js';
import { CoreAgentAdapter } from './core-agent-adapter.js';
import type { ImageAttachment, ModelSelection, ResolvedImageAttachment, Session } from '@moke/protocol';

export function createToolRegistry(input: {
  defaultWorkspaceRoot: string;
  browserBridge: BrowserBridge;
}) {
  const system = new LocalSystemBackend(input.defaultWorkspaceRoot);
  const browserBackend = new BrowserBridgeBackend(input.browserBridge);
  const skillLoaders = new Map<string, SkillLoader>();
  const getSkillLoader = (root: string) => {
    const normalizedRoot = path.resolve(root);
    let loader = skillLoaders.get(normalizedRoot);
    if (!loader) {
      loader = new SkillLoader(normalizedRoot);
      skillLoaders.set(normalizedRoot, loader);
    }
    return loader;
  };
  const toolRegistry = new ToolRegistry()
    .register(createActivateSkillTool(getSkillLoader));

  registerAgentTools(toolRegistry, system);
  registerBrowserTools(toolRegistry, browserBackend);

  return {
    system,
    toolRegistry,
    createSkillContentManager: async (root: string) =>
      new ContentManager({ catalog: await getSkillLoader(root).list() }),
  };
}

export function createRunManager(input: {
  runs: Map<string, RuntimeRun>;
  toolRegistry: ToolRegistry;
  resolveToolRegistry?: (workspace: string) => ToolRegistry | Promise<ToolRegistry>;
  createSkillContentManager: (workspace: string) => RuntimeContentManager | Promise<RuntimeContentManager>;
  defaultWorkspaceRoot: string;
  approveWorkspaceRoot: (root: string, scope: 'once' | 'session' | 'persistent', sessionId: string) => WorkspacePathApprovalDecision | void;
  workspaceRoots: (sessionId: string) => string[];
  getModelSettings: (selection?: ModelSelection) => Partial<ChatModelSettings>;
  resolveImageAttachments: (
    attachments: ImageAttachment[],
  ) => ResolvedImageAttachment[] | Promise<ResolvedImageAttachment[]>;
  onSessionChanged: (session: Session) => void;
}) {
  return new RunManager({
    runs: input.runs,
    agent: new CoreAgentAdapter(input.getModelSettings),
    toolRegistry: input.toolRegistry,
    resolveToolRegistry: input.resolveToolRegistry,
    defaultWorkspaceRoot: input.defaultWorkspaceRoot,
    createSkillContentManager: input.createSkillContentManager,
    approveWorkspaceRoot: input.approveWorkspaceRoot,
    workspaceRoots: input.workspaceRoots,
    resolveImageAttachments: input.resolveImageAttachments,
    onSessionChanged: input.onSessionChanged,
  });
}
