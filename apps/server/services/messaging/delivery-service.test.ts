import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeRun } from '@moke/agent-runtime';
import type { AgentEvent } from '@moke/protocol';
import { MessagingDeliveryService } from './delivery-service.js';
import type { MessagingConnectionManager } from './connection-manager.js';

test('terminal delivery remains pending until the outbound message completes', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const connections = {
    stopTypingForRun: async () => undefined,
    sendTextForBinding: async () => gate,
  } as unknown as MessagingConnectionManager;
  const delivery = new MessagingDeliveryService(connections);
  const run = {
    id: 'run_1',
    origin: {
      kind: 'messaging',
      platform: 'weixin',
      connection_id: 'wxconn_1',
      binding_id: 'bind_1',
      inbound_message_id: 'message_1',
    },
  } as RuntimeRun;
  delivery.onRunEvent({
    type: 'agent.message.done',
    payload: { message: { role: 'assistant', content: 'done', created_at: new Date().toISOString() } },
  } as AgentEvent, run);
  delivery.onRunEvent({ type: 'agent.done', payload: { status: 'completed', usage: { steps: 1, tool_calls: 0, duration_ms: 1 } } } as AgentEvent, run);
  let completed = false;
  const waiting = delivery.waitForTerminal(run.id).then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await waiting;
  assert.equal(completed, true);
});
