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
import { MessagingConnectionPool } from './services/messaging/connection-pool.js';
import { MessagingRuntime } from './services/messaging/messaging-runtime.js';
import { createSendMessageTool } from './services/messaging/send-message-tool.js';
import { WeixinLoginService } from './services/messaging/weixin-login-service.js';
import { WeixinAdapter } from '@moke/messaging-weixin';
import { DingTalkAdapter } from '@moke/messaging-dingtalk';
import { FeishuAdapter } from '@moke/messaging-feishu';

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
  const messagingConnectionPool = new MessagingConnectionPool(messagingStore);
  messagingConnectionPool
    .register('weixin', (connection, secret) => {
      if (connection.platform !== 'weixin') throw new Error('Invalid WeChat connection');
      return new WeixinAdapter({
        accountId: connection.id,
        botUserId: connection.ilink_bot_id,
        token: secret,
        baseUrl: connection.api_base_url,
      });
    })
    .register('dingtalk', (connection, secret) => {
      if (connection.platform !== 'dingtalk') throw new Error('Invalid DingTalk connection');
      return new DingTalkAdapter({
        accountId: connection.id,
        clientId: connection.client_id,
        clientSecret: secret,
        allowedUserIds: connection.allowed_user_ids,
        cardTemplateId: connection.card_template_id,
      });
    })
    .register('feishu', (connection, secret) => {
      if (connection.platform !== 'feishu') throw new Error('Invalid Feishu connection');
      return new FeishuAdapter({
        accountId: connection.id,
        appId: connection.app_id,
        appSecret: secret,
        domain: connection.domain,
      });
    });
  const messagingRuntime = new MessagingRuntime(
    messagingStore,
    messagingConnectionPool,
    sessionApplicationService,
    runManager,
    attachmentStore,
    workspace,
    () => [...approvedMessagingRoots],
  );
  toolRegistry.register(createSendMessageTool(messagingRuntime));
  const removeMessagingObserver = runManager.addObserver((event, run) => {
    messagingRuntime.onRunEvent(event, run);
  });
  const weixinLoginService = new WeixinLoginService(messagingRuntime);

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
      messagingRuntime,
      weixinLoginService,
    }),
  );

  await messagingRuntime.start();

  return {
    port,
    server,
    close: async () => {
      const httpClosed = closeHttpServer(server);
      removeMessagingObserver();
      const messagingClosed = messagingRuntime.close();
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
