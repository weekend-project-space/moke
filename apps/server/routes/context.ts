import type { RunManager, RuntimeRun, ToolRegistry } from '@moke/agent-runtime';
import type { Session } from '@moke/protocol';
import type { BrowserBridge } from '../services/browser-bridge.js';
import type { McpSettingsService } from '../services/mcp-settings-service.js';
import type { PermissionsService } from '../services/permissions-service.js';
import type { SettingsService } from '../services/settings-service.js';
import type { SkillSettingsService } from '../services/skill-settings-service.js';

export type RoutesContext = {
  sessions: Map<string, Session>;
  runs: Map<string, RuntimeRun>;
  runManager: RunManager;
  toolRegistry: ToolRegistry;
  browserBridge: BrowserBridge;
  mcpSettingsService: McpSettingsService;
  permissionsService: PermissionsService;
  settingsService: SettingsService;
  skillSettingsService: SkillSettingsService;
  onChange: () => void;
};
