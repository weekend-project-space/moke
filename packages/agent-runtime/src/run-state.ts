import type { ServerResponse } from 'node:http';

import type { ApprovalMode, RunSnapshot, SessionEnvironment } from '@moke/protocol';

export type RunOrigin =
  | { kind: 'local' }
  | {
      kind: 'scheduled';
      task_id: string;
    }
  | {
      kind: 'messaging';
      platform: string;
      connection_id: string;
      binding_id: string;
      inbound_message_id: string;
    };

export type RuntimeRun = RunSnapshot & {
  clients: Set<ServerResponse>;
  started_at: number;
  abort: boolean;
  cancel_reason?: 'user' | 'shutdown';
  origin: RunOrigin;
  approval_mode: ApprovalMode;
  env: SessionEnvironment;
  outbound_tool_texts?: string[];
};
