import type { RunManager, ToolRegistry } from '../../../packages/agent-runtime/src/index.js';
import type { Run, Session } from '../../../packages/protocol/src/index.js';
import type { BrowserBridge } from '../services/browser-bridge.js';
import type { PermissionsService } from '../services/permissions-service.js';
import type { SettingsService } from '../services/settings-service.js';

export type RoutesContext = {
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  runManager: RunManager;
  toolRegistry: ToolRegistry;
  browserBridge: BrowserBridge;
  permissionsService: PermissionsService;
  settingsService: SettingsService;
  onChange: () => void;
};
