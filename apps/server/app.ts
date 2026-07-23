import http from 'node:http';

import type { RuntimeRun } from '@moke/agent-runtime';
import {
  loadFirstEnvFile,
  resolveEnvPaths,
  resolvePath,
  resolveServerConfig,
  type ServerConfig,
} from './config/paths.js';
import { createToolRegistry, createRunManager } from './runtime/factory.js';
import { createRoutes } from './routes/index.js';
import { BrowserBridge } from './services/browser-bridge.js';
import { McpSettingsService } from './services/mcp-settings-service.js';
import { registerMcpTools } from './services/mcp-tools.js';
import { PermissionsService } from './services/permissions-service.js';
import { SettingsService } from './services/settings-service.js';
import { SkillSettingsService } from './services/skill-settings-service.js';
import { JsonSessionStore } from './storage/session-store.js';
import { AttachmentStore } from './storage/attachment-store.js';
import { JsonMessagingStore } from './storage/messaging-store.js';
import { summarizeSession } from './domain/sessions.js';
import { SessionApplicationService } from './services/session-application-service.js';
import { MessagingGateway } from './services/messaging/messaging-gateway.js';
import { MessagingConnectionManager } from './services/messaging/connection-manager.js';
import { MessagingDeliveryService } from './services/messaging/delivery-service.js';
import { DefaultMessagingOutboundService } from './services/messaging/messaging-outbound-service.js';
import { createSendMessageTool } from './services/messaging/send-message-tool.js';
import { WeixinLoginService } from './services/messaging/weixin-login-service.js';

export {
  normalizeWindowsDrivePath,
  resolveEnvPaths,
  resolvePath,
  resolvePort,
  resolveServerConfig,
} from './config/paths.js';
export type { ServerConfig } from './config/paths.js';

export type ServerApp = {
  port: number;
  server: http.Server;
  close: () => Promise<void>;
};

function closeHttpServer(server: http.Server) {
  if (!server.listening) return Promise.resolve();

  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export async function createApp(): Promise<ServerApp> {
  const initialWorkspace = resolvePath(process.env.MOKE_WORKSPACE, process.cwd(), process.cwd());
  const loadedEnvPath = loadFirstEnvFile(resolveEnvPaths(initialWorkspace));
  if (loadedEnvPath) console.log(`Loaded environment from ${loadedEnvPath}`);

  const config: ServerConfig = resolveServerConfig();
  const { mcpConfigPath, permissionsPath, port, settingsPath, statePath, storePath, workspace } = config;

  const runs = new Map<string, RuntimeRun>();
  const browserBridge = new BrowserBridge();
  const mcpSettingsService = new McpSettingsService(mcpConfigPath);
  const settingsService = new SettingsService(settingsPath);
  const skillSettingsService = new SkillSettingsService(workspace);
  const sessionStore = new JsonSessionStore({ storePath, legacyStatePath: statePath, summarizeSession });
  const attachmentStore = new AttachmentStore(storePath);
  const messagingStore = new JsonMessagingStore(storePath);
  const { system, toolRegistry } = createToolRegistry(workspace, browserBridge);
  const permissionsService = new PermissionsService(permissionsPath, {
    revokeWorkspaceRoot: (root) => system.revokeWorkspaceRoot(root),
  });
  const approvedMessagingRoots = new Set([workspace]);
  for (const permission of permissionsService.listWorkspaceRoots()) {
    system.approveWorkspaceRoot(permission.path);
    approvedMessagingRoots.add(permission.path);
  }

  sessionStore.initialize();
  attachmentStore.migrateInlineAttachments(sessionStore);
  messagingStore.initialize();

  const mcpManager = await registerMcpTools(toolRegistry, mcpConfigPath, workspace);
  const runManager = createRunManager({
    runs,
    toolRegistry,
    workspace,
    approveWorkspaceRoot: (root, scope) => {
      const approval = system.approveWorkspaceRoot(root);
      approvedMessagingRoots.add(approval.path);
      if (scope === 'once') {
        return approval.added ? () => {
          system.revokeWorkspaceRoot(root);
          approvedMessagingRoots.delete(approval.path);
        } : undefined;
      }
      if (scope === 'persistent') {
        permissionsService.upsertWorkspaceRoot(root);
      }
    },
    getModelSettings: () => settingsService.getModelSettings(),
    resolveImageAttachments: (attachments) => attachments.map((attachment) => attachmentStore.resolve(attachment)),
    onSessionChanged: (session) => sessionStore.save(session),
  });
  const sessionApplicationService = new SessionApplicationService(sessionStore, runManager);
  // Keep queued messaging work independent from the HTTP server lifecycle.
  const messagingGateway = new MessagingGateway(messagingStore, sessionApplicationService, attachmentStore);
  const messagingConnectionManager = new MessagingConnectionManager(messagingStore, messagingGateway);
  const messagingDeliveryService = new MessagingDeliveryService(messagingConnectionManager);
  messagingGateway.setRunStartedListener((input) => {
    messagingConnectionManager.startTypingForBinding(input.connectionId, input.bindingId, input.runId);
    messagingDeliveryService.onRunStarted(input);
  });
  messagingConnectionManager.setCardActionHandler((action) => {
    const value = action.value;
    const runId = typeof value.runId === 'string' ? value.runId : '';
    const requestId = typeof value.requestId === 'string' ? value.requestId : '';
    let result: { status: number; error?: string };
    if (typeof value.responderOpenId === 'string' && value.responderOpenId !== action.openId) {
      result = { status: 403, error: 'Only the person who started this task can respond' };
    } else if (value.action === 'ask' && typeof value.optionId === 'string') {
      result = runManager.answer(runId, requestId, value.optionId);
    } else if (value.action === 'approve' && (value.decision === 'approved' || value.decision === 'rejected')) {
      const scope = value.scope === 'once' || value.scope === 'persistent' ? value.scope : 'session';
      result = runManager.approve(runId, requestId, value.decision, { scope });
    } else {
      result = { status: 400, error: 'Invalid card action' };
    }
    return {
      toast: {
        type: result.status === 200 ? 'success' : 'warning',
        content: result.status === 200 ? 'Response received' : result.error || 'This request is no longer pending',
      },
    };
  });
  const messagingOutboundService = new DefaultMessagingOutboundService(
    messagingStore,
    messagingConnectionManager,
    workspace,
    () => [...approvedMessagingRoots],
  );
  toolRegistry.register(createSendMessageTool(messagingOutboundService));
  const removeMessagingObserver = runManager.addObserver((event, run) => {
    messagingDeliveryService.onRunEvent(event, run);
    const preserveQueuedMessage = event.type === 'agent.done'
      && event.payload.status === 'cancelled'
      && run.cancel_reason === 'shutdown';
    const bindingId = run.origin.kind === 'messaging' ? run.origin.binding_id : undefined;
    if (bindingId && !preserveQueuedMessage && (event.type === 'agent.done' || event.type === 'agent.error')) {
      void messagingDeliveryService.waitForTerminal(run.id).then(() =>
        messagingGateway.completeRun({ bindingId, runId: run.id }));
    }
  });
  const weixinLoginService = new WeixinLoginService(messagingStore, messagingConnectionManager);

  const server = http.createServer(
    createRoutes({
      sessionStore,
      attachmentStore,
      runs,
      runManager,
      toolRegistry,
      browserBridge,
      mcpSettingsService,
      permissionsService,
      settingsService,
      skillSettingsService,
      messagingStore,
      messagingConnectionManager,
      weixinLoginService,
    }),
  );

  await messagingConnectionManager.startAll();
  await messagingGateway.resumeQueued();

  return {
    port,
    server,
    close: async () => {
      const httpClosed = closeHttpServer(server);
      removeMessagingObserver();
      const messagingClosed = messagingConnectionManager.close();
      const runsStopped = runManager.shutdown();
      browserBridge.close();
      await mcpManager?.close();
      await messagingClosed;
      await runsStopped;
      await httpClosed;
      sessionStore.flush();
    },
  };
}
