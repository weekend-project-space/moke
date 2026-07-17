import type { RunManager, RuntimeRun, ToolRegistry } from '@moke/agent-runtime';
import type { BrowserBridge } from '../services/browser-bridge.js';
import type { McpSettingsService } from '../services/mcp-settings-service.js';
import type { PermissionsService } from '../services/permissions-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { SkillSettingsService } from '../services/skill-settings-service.js';
import type { SessionRepository } from '../storage/session-store.js';
import type { AttachmentStore } from '../storage/attachment-store.js';

export type RoutesContext = {
  sessionStore: SessionRepository;
  attachmentStore: AttachmentStore;
  runs: Map<string, RuntimeRun>;
  runManager: RunManager;
  toolRegistry: ToolRegistry;
  browserBridge: BrowserBridge;
  mcpSettingsService: McpSettingsService;
  permissionsService: PermissionsService;
  settingsService: SettingsService;
  skillSettingsService: SkillSettingsService;
};
