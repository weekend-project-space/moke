import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeRun } from '@moke/agent-runtime';
import { PathRequiresApprovalError } from '@moke/agent-runtime';
import { createSendMessageTool } from './send-message-tool.js';

test('send_message binds output to the current external messaging run', async () => {
  let request: Record<string, unknown> | undefined;
  const tool = createSendMessageTool({
    async send(input) {
      request = input;
      return { receipts: [{ type: 'text', delivered_at: '2026-01-01T00:00:00.000Z' }] };
    },
  });
  const run = {
    id: 'run_1',
    origin: { kind: 'messaging', platform: 'weixin', connection_id: 'wxconn_1', binding_id: 'bind_1', inbound_message_id: 'message_1' },
  } as RuntimeRun;

  const output = await tool.handler({ text: 'sent' }, {
    workspace: process.cwd(),
    run,
    currentToolCall: { callId: 'call_1', tool: 'send_message', input: {} },
  });

  assert.equal((request as { binding_id: string }).binding_id, 'bind_1');
  assert.equal((request as { idempotency_key: string }).idempotency_key, 'run_1:tool:call_1');
  assert.deepEqual(run.outbound_tool_texts, ['sent']);
  assert.equal(Array.isArray(output.receipts), true);
});

test('send_message rejects local runs', async () => {
  const tool = createSendMessageTool({ async send() { throw new Error('should not send'); } });
  await assert.rejects(
    () => tool.handler({ text: 'sent' }, { workspace: process.cwd(), run: { id: 'run_1', origin: { kind: 'local' } } as RuntimeRun }),
    /current external messaging conversation/,
  );
});

test('send_message accepts a DingTalk messaging run', async () => {
  let request: Record<string, unknown> | undefined;
  const tool = createSendMessageTool({
    async send(input) {
      request = input;
      return { receipts: [{ type: 'text', delivered_at: '2026-01-01T00:00:00.000Z' }] };
    },
  });
  const run = {
    id: 'run_ding_1',
    origin: { kind: 'messaging', platform: 'dingtalk', connection_id: 'dtconn_1', binding_id: 'bind_1', inbound_message_id: 'message_1' },
  } as RuntimeRun;

  await tool.handler({ text: 'sent' }, {
    workspace: process.cwd(),
    run,
    currentToolCall: { callId: 'call_1', tool: 'send_message', input: {} },
  });

  assert.equal((request as { binding_id: string }).binding_id, 'bind_1');
});

test('send_message accepts a Feishu messaging run', async () => {
  let sent = false;
  const tool = createSendMessageTool({
    send: async () => {
      sent = true;
      return { receipts: [{ type: 'text', delivered_at: '2026-07-23T00:00:00.000Z' }] };
    },
  });
  const run = {
    id: 'run_feishu_1',
    origin: { kind: 'messaging', platform: 'feishu', connection_id: 'fsconn_1', binding_id: 'bind_1', inbound_message_id: 'message_1' },
  } as RuntimeRun;
  await tool.handler({ text: 'hello' }, {
    workspace: process.cwd(),
    run,
    currentToolCall: { callId: 'call_1', tool: 'send_message', input: {} },
  });
  assert.equal(sent, true);
});

test('send_message validates media paths while ToolRegistry owns approval', async () => {
  let request: { contents: Array<{ type: string }> } | undefined;
  let validatedWorkspace = '';
  let sentWorkspace = '';
  const tool = createSendMessageTool({
    async validateMediaPaths(_contents, access) {
      validatedWorkspace = access?.workspaceRoot || '';
    },
    async send(input, access) {
      request = input;
      sentWorkspace = access?.workspaceRoot || '';
      return { receipts: [{ type: 'image', delivered_at: '2026-01-01T00:00:00.000Z' }] };
    },
  });
  const run = {
    id: 'run_1',
    origin: { kind: 'messaging', platform: 'weixin', connection_id: 'wxconn_1', binding_id: 'bind_1', inbound_message_id: 'message_1' },
  } as RuntimeRun;

  await tool.handler({ images: [{ path: 'output/image.png' }] }, {
    workspace: process.cwd(),
    run,
    currentToolCall: { callId: 'call_1', tool: 'send_message', input: {} },
  });

  assert.deepEqual(request?.contents, [{ type: 'image', path: 'output/image.png' }]);
  assert.equal(validatedWorkspace, process.cwd());
  assert.equal(sentWorkspace, process.cwd());
});

test('send_message preserves media path approval errors for ToolRegistry retry', async () => {
  const tool = createSendMessageTool({
    async validateMediaPaths() {
      throw new PathRequiresApprovalError({
        path: 'C:\\Temp\\image.png',
        suggestedRoot: 'C:\\Temp',
      });
    },
    async send() {
      throw new Error('should not send');
    },
  });
  const run = {
    id: 'run_1',
    origin: { kind: 'messaging', platform: 'weixin', connection_id: 'wxconn_1', binding_id: 'bind_1', inbound_message_id: 'message_1' },
  } as RuntimeRun;

  await assert.rejects(
    () => tool.handler({ images: [{ path: 'C:\\Temp\\image.png' }] }, {
      workspace: process.cwd(),
      run,
      currentToolCall: { callId: 'call_1', tool: 'send_message', input: {} },
    }),
    PathRequiresApprovalError,
  );
});
