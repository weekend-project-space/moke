import type { ServerResponse } from 'node:http';

import type { RunSnapshot } from '../../protocol/src/index.js';

export type RuntimeRun = RunSnapshot & {
  clients: Set<ServerResponse>;
  started_at: number;
  abort: boolean;
};
