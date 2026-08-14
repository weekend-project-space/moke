import assert from 'node:assert/strict';
import test from 'node:test';

import type { MessagingOutboundOperation } from '@moke/messaging-core';
import { WeixinAdapter } from './adapter.js';

test('Weixin interaction prompts allow text replies only for questions', async () => {
  const sent: string[] = [];
  const adapter = new WeixinAdapter({
    accountId: 'wxconn_1',
    token: 'token',
    client: {
      async sendText(input: { text: string }) { sent.push(input.text); },
    } as never,
  });
  (adapter as unknown as { context: { state: { get: () => string } } }).context = {
    state: { get: () => 'context-token' },
  };
  const base = {
    kind: 'interaction' as const,
    interaction_id: 'int_1',
    title: 'Input required',
    detail: 'Choose one',
    options: [{ id: 'one', label: 'First' }, { id: 'two', label: 'Second' }],
  };
  const target = {
    account_id: 'wxconn_1',
    binding_id: 'bind_1',
    conversation: { id: 'user_1', type: 'direct' as const },
  };

  await adapter.deliver(target, { ...base, interaction_kind: 'ask' } satisfies MessagingOutboundOperation);
  await adapter.deliver(target, { ...base, interaction_kind: 'approval' } satisfies MessagingOutboundOperation);

  assert.match(sent[0] || '', /Reply with the option number or exact option text\.$/);
  assert.match(sent[1] || '', /Open Moke to respond\.$/);
});
