import assert from 'node:assert/strict';
import test from 'node:test';

import { PathRequiresApprovalError, ToolExecutionError, type RuntimeRun } from '@moke/agent-runtime';
import type { MessagingToolBackend } from './messaging-tool-backend.js';
import { createSendMessageTool } from './send-message.js';

test('send_message replies to the current external conversation', async () => {
  let bindingId = '';
  let resolved = false;
  const tool = createSendMessageTool(createBackend({
    resolveTarget() {
      resolved = true;
      return { status: 'not_found' };
    },
    async send(input) {
      bindingId = input.binding_id;
      return deliveryResult();
    },
  }));

  await tool.handler({ platform: 'feishu', text: 'sent' }, toolContext(messagingRun()));

  assert.equal(bindingId, 'bind_current');
  assert.equal(resolved, false);
});

test('send_message resolves a platform target for a local run', async () => {
  let bindingId = '';
  const tool = createSendMessageTool(createBackend({
    resolveTarget(input) {
      assert.deepEqual(input, { platform: 'feishu', sessionId: 'sess_local' });
      return { status: 'resolved', bindingId: 'bind_feishu' };
    },
    async send(input) {
      bindingId = input.binding_id;
      return deliveryResult();
    },
  }));

  await tool.handler({ platform: 'feishu', text: 'sent' }, toolContext(localRun()));

  assert.equal(bindingId, 'bind_feishu');
});

test('send_message requires a platform outside an external messaging run', async () => {
  const tool = createSendMessageTool(createBackend());

  await assert.rejects(
    () => tool.handler({ text: 'sent' }, toolContext(localRun())),
    toolErrorCode('MESSAGING_TARGET_REQUIRED'),
  );
});

test('send_message reports missing and ambiguous platform targets', async () => {
  const missing = createSendMessageTool(createBackend());
  const ambiguous = createSendMessageTool(createBackend({
    resolveTarget: () => ({ status: 'ambiguous', count: 2 }),
  }));

  await assert.rejects(
    () => missing.handler({ platform: 'dingtalk', text: 'sent' }, toolContext(localRun())),
    toolErrorCode('MESSAGING_TARGET_NOT_FOUND'),
  );
  await assert.rejects(
    () => ambiguous.handler({ platform: 'dingtalk', text: 'sent' }, toolContext(localRun())),
    toolErrorCode('MESSAGING_TARGET_AMBIGUOUS'),
  );
});

test('send_message validates media with the current workspace access', async () => {
  let validatedWorkspace = '';
  let sentWorkspace = '';
  const tool = createSendMessageTool(createBackend({
    async validateMediaPaths(_contents, access) {
      validatedWorkspace = access.workspaceRoot;
    },
    async send(_input, access) {
      sentWorkspace = access.workspaceRoot;
      return { receipts: [{ type: 'image', delivered_at: '2026-07-31T00:00:00.000Z' }] };
    },
  }));

  await tool.handler({ images: [{ path: 'output/image.png' }] }, toolContext(messagingRun()));

  assert.equal(validatedWorkspace, process.cwd());
  assert.equal(sentWorkspace, process.cwd());
});

test('send_message preserves media path approval errors for ToolRegistry retry', async () => {
  const tool = createSendMessageTool(createBackend({
    async validateMediaPaths() {
      throw new PathRequiresApprovalError({
        path: 'C:\\Temp\\image.png',
        suggestedRoot: 'C:\\Temp',
      });
    },
  }));

  await assert.rejects(
    () => tool.handler({ images: [{ path: 'C:\\Temp\\image.png' }] }, toolContext(messagingRun())),
    PathRequiresApprovalError,
  );
});

function createBackend(overrides: Partial<MessagingToolBackend> = {}): MessagingToolBackend {
  return {
    resolveTarget: () => ({ status: 'not_found' }),
    async validateMediaPaths() {},
    async send() { return deliveryResult(); },
    ...overrides,
  };
}

function deliveryResult() {
  return { receipts: [{ type: 'text' as const, delivered_at: '2026-07-31T00:00:00.000Z' }] };
}

function localRun() {
  return { id: 'run_local', session_id: 'sess_local', origin: { kind: 'local' } } as RuntimeRun;
}

function messagingRun() {
  return {
    id: 'run_feishu',
    session_id: 'sess_feishu',
    origin: {
      kind: 'messaging',
      platform: 'feishu',
      connection_id: 'conn_1',
      binding_id: 'bind_current',
      inbound_message_id: 'msg_1',
    },
  } as RuntimeRun;
}

function toolContext(run: RuntimeRun) {
  return {
    workspace: process.cwd(),
    run,
    currentToolCall: { callId: 'call_1', tool: 'send_message', input: {} },
  };
}

function toolErrorCode(code: string) {
  return (error: unknown) =>
    error instanceof ToolExecutionError
    && (error.output.error as { code?: string } | undefined)?.code === code;
}
