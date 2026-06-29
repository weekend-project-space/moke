import type { RunManager, ToolRegistry } from '../../../packages/agent-runtime/src/index.js';
import type { Run, Session } from '../../../packages/protocol/src/index.js';
import type { BrowserBridge } from '../services/browser-bridge.js';

export type RoutesContext = {
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  runManager: RunManager;
  toolRegistry: ToolRegistry;
  browserBridge: BrowserBridge;
  onChange: () => void;
};
