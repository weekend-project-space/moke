import type { ServerResponse } from 'node:http';

import type { RunSnapshot } from '@moke/protocol';

export type RuntimeRun = RunSnapshot & {
  clients: Set<ServerResponse>;
  started_at: number;
  abort: boolean;
};
