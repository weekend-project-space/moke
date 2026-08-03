import http from 'node:http';
import path from 'node:path';

import type { RuntimeRun } from '@moke/agent-runtime';
import { registerMessagingTools } from '@moke/messaging-tools';
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
import { ScheduledTaskStore } from './storage/scheduled-task-store.js';
import { summarizeSession } from './domain/sessions.js';
import { SessionApplicationService } from './services/session-application-service.js';
import { MessagingConnectionPool } from './services/messaging/connection-pool.js';
import { MessagingRuntime } from './services/messaging/messaging-runtime.js';
import { WeixinLoginService } from './services/messaging/weixin-login-service.js';
import { FeishuLoginService } from './services/messaging/feishu-login-service.js';
import { WeixinAdapter } from '@moke/messaging-weixin';
import { DingTalkAdapter } from '@moke/messaging-dingtalk';
import { FeishuAdapter } from '@moke/messaging-feishu';
import { ScheduledTaskService } from './services/scheduled-task-service.js';

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
  const initialAppRoot = resolvePath(process.env.MOKE_APP_ROOT, process.cwd(), process.cwd());
  const loadedEnvPath = loadFirstEnvFile(resolveEnvPaths(initialAppRoot));
  if (loadedEnvPath) console.log(`Loaded environment from ${loadedEnvPath}`);

  const config: ServerConfig = resolveServerConfig();
  const {
    defaultWorkspaceRoot,
    mcpConfigPath,
    permissionsPath,
    port,
    settingsPath,
    statePath,
    storePath,
  } = config;

  const runs = new Map<string, RuntimeRun>();
  const browserBridge = new BrowserBridge();
  const mcpSettingsService = new McpSettingsService(mcpConfigPath);
  const settingsService = new SettingsService(settingsPath);
  const skillSettingsService = new SkillSettingsService(defaultWorkspaceRoot);
  const sessionStore = new JsonSessionStore({ storePath, legacyStatePath: statePath, summarizeSession, workspace: defaultWorkspaceRoot });
  const attachmentStore = new AttachmentStore(storePath);
  const messagingStore = new JsonMessagingStore(storePath);
  const scheduledTaskStore = new ScheduledTaskStore(storePath);
  const { system, toolRegistry, createSkillContentManager } = createToolRegistry({
    defaultWorkspaceRoot,
    browserBridge,
  });
  const permissionsService = new PermissionsService(permissionsPath, {
    revokeWorkspaceRoot: (root) => system.revokeWorkspaceRoot(root),
  });
  const approvedMessagingRoots = new Set([defaultWorkspaceRoot]);
  const sessionWorkspaceRoots = new Map<string, Set<string>>();
  for (const permission of permissionsService.listWorkspaceRoots()) {
    system.approveWorkspaceRoot(permission.path);
    approvedMessagingRoots.add(permission.path);
  }

  sessionStore.initialize();
  attachmentStore.migrateInlineAttachments(sessionStore);
  messagingStore.initialize();
  scheduledTaskStore.initialize();

  const mcpManager = await registerMcpTools(toolRegistry, mcpConfigPath, defaultWorkspaceRoot);
  const runManager = createRunManager({
    runs,
    toolRegistry,
    createSkillContentManager,
    defaultWorkspaceRoot,
    approveWorkspaceRoot: (root, scope, sessionId) => {
      const normalizedRoot = path.resolve(root);
      if (scope === 'once') {
        return { approved: true, scope, approvedRoots: [normalizedRoot] };
      }
      if (scope === 'session') {
        const roots = sessionWorkspaceRoots.get(sessionId) || new Set<string>();
        roots.add(normalizedRoot);
        sessionWorkspaceRoots.set(sessionId, roots);
        return { approved: true, scope };
      }
      const approval = system.approveWorkspaceRoot(normalizedRoot);
      approvedMessagingRoots.add(approval.path);
      if (scope === 'persistent') {
        permissionsService.upsertWorkspaceRoot(root);
      }
      return { approved: true, scope };
    },
    workspaceRoots: (sessionId) => [...(sessionWorkspaceRoots.get(sessionId) || [])],
    getModelSettings: () => settingsService.getModelSettings(),
    resolveImageAttachments: (attachments) => attachments.map((attachment) => attachmentStore.resolve(attachment)),
    onSessionChanged: (session) => sessionStore.save(session),
  });
  const sessionApplicationService = new SessionApplicationService(sessionStore, runManager, defaultWorkspaceRoot);
  const scheduledTaskService = new ScheduledTaskService(scheduledTaskStore, sessionApplicationService);
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
    defaultWorkspaceRoot,
    () => [...approvedMessagingRoots],
  );
  registerMessagingTools(toolRegistry, messagingRuntime);
  const removeMessagingObserver = runManager.addObserver((event, run) => {
    messagingRuntime.onRunEvent(event, run);
  });
  const weixinLoginService = new WeixinLoginService(messagingRuntime);
  const feishuLoginService = new FeishuLoginService(messagingRuntime);

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
      feishuLoginService,
      scheduledTaskService,
       defaultWorkspaceRoot,
     }, {
       apiToken: process.env.MOKE_API_TOKEN,
     }),
  );

  await messagingRuntime.start();
  scheduledTaskService.start();

  return {
    port,
    server,
    close: async () => {
      scheduledTaskService.stop();
      const httpClosed = closeHttpServer(server);
      removeMessagingObserver();
      feishuLoginService.close();
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
