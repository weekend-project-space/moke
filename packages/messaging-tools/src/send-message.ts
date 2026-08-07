import { z } from 'zod';

import { ToolExecutionError, type RuntimeRun, type RuntimeTool, type ToolContext } from '@moke/agent-runtime';
import type { MessagingPlatform, OutboundContent } from '@moke/messaging-core';
import type { MessagingToolBackend, ResolvedMessagingTarget } from './messaging-tool-backend.js';

const mediaSchema = z.object({
  path: z.string().min(1),
  caption: z.string().max(2_000).optional(),
});

const fileSchema = mediaSchema.extend({
  name: z.string().max(120).optional(),
});

const sendMessageSchema = z.object({
  platform: z.enum(['weixin', 'dingtalk', 'feishu']).optional(),
  text: z.string().max(8_000).optional(),
  images: z.array(mediaSchema).max(4).optional(),
  files: z.array(fileSchema).max(4).optional(),
}).refine((input) => Boolean(input.text?.trim() || input.images?.length || input.files?.length), {
  message: 'text, images, or files is required',
});

export function createSendMessageTool(backend: MessagingToolBackend): RuntimeTool<typeof sendMessageSchema> {
  return {
    name: 'send_message',
    description: 'Send text, images, or files through a messaging platform. In an external messaging run it defaults to the current conversation; local and scheduled runs must specify a platform with one resolvable target. Media paths outside the workspace require directory approval.',
    approval: 'required',
    schema: sendMessageSchema,
    async prepare(input, context) {
      const prepared = await prepareMessage(input, context, backend);
      return {
        approvalInput: {
          platform: prepared.target.platform,
          connection_id: prepared.target.connectionId,
          binding_id: prepared.target.bindingId,
          conversation: {
            id: prepared.target.conversationId,
            type: prepared.target.conversationType,
          },
          ...(input.text?.trim() ? { text: input.text.trim() } : {}),
          ...(input.images?.length ? { images: input.images } : {}),
          ...(input.files?.length ? { files: input.files } : {}),
        },
        execute: (executionContext) => executePreparedMessage(prepared, executionContext, backend),
      };
    },
    async handler(input, context) {
      return executePreparedMessage(await prepareMessage(input, context, backend), context, backend);
    },
  };
}

type PreparedMessage = {
  target: ResolvedMessagingTarget;
  runId: string;
  idempotencyKey: string;
  contents: OutboundContent[];
};

async function prepareMessage(
  input: z.infer<typeof sendMessageSchema>,
  context: ToolContext,
  backend: MessagingToolBackend,
): Promise<PreparedMessage> {
  const run = context.run;
  if (!run) throw toolError('send_message requires an active run', 'RUN_REQUIRED');
  const target = resolveTarget(input.platform, run, backend);
  const contents = toOutboundContents(input);
  const access = workspaceAccess(context);
  if (contents.some((content) => content.type !== 'text')) await backend.validateMediaPaths(contents, access);
  const callId = context.currentToolCall?.callId;
  if (!callId) throw toolError('send_message requires a tool call id', 'TOOL_CALL_ID_REQUIRED');
  return {
    target,
    runId: run.id,
    idempotencyKey: `${run.id}:tool:${callId}`,
    contents,
  };
}

async function executePreparedMessage(
  prepared: PreparedMessage,
  context: ToolContext,
  backend: MessagingToolBackend,
) {
  const result = await backend.send({
    binding_id: prepared.target.bindingId,
    run_id: prepared.runId,
    idempotency_key: prepared.idempotencyKey,
    contents: prepared.contents,
  }, workspaceAccess(context));
  return { receipts: result.receipts };
}

function resolveTarget(platform: MessagingPlatform | undefined, run: RuntimeRun, backend: MessagingToolBackend) {
  if (run.origin.kind === 'messaging' && (!platform || platform === run.origin.platform)) {
    const target = backend.getTarget(run.origin.binding_id);
    if (target) return target;
    throw toolError(`No messaging target is available for ${run.origin.platform}`, 'MESSAGING_TARGET_NOT_FOUND');
  }
  if (!platform) {
    throw toolError('send_message requires platform outside an external messaging conversation', 'MESSAGING_TARGET_REQUIRED');
  }
  const target = backend.resolveTarget({ platform, sessionId: run.session_id });
  if (target.status === 'resolved') return target.target;
  if (target.status === 'ambiguous') {
    throw toolError(
      `Multiple ${platform} messaging targets are available (${target.count}); a unique target is required`,
      'MESSAGING_TARGET_AMBIGUOUS',
    );
  }
  throw toolError(`No messaging target is available for ${platform}`, 'MESSAGING_TARGET_NOT_FOUND');
}

function workspaceAccess(context: ToolContext) {
  return {
    workspaceRoot: context.workspace,
    approvedRoots: context.workspaceRoots?.(),
  };
}

function toOutboundContents(input: z.infer<typeof sendMessageSchema>): OutboundContent[] {
  return [
    ...(input.text?.trim() ? [{ type: 'text' as const, text: input.text.trim() }] : []),
    ...(input.images || []).map((image) => ({ type: 'image' as const, path: image.path, ...(image.caption ? { caption: image.caption } : {}) })),
    ...(input.files || []).map((file) => ({ type: 'file' as const, path: file.path, ...(file.name ? { name: file.name } : {}), ...(file.caption ? { caption: file.caption } : {}) })),
  ];
}

function toolError(message: string, code: string) {
  return new ToolExecutionError(message, { error: { code, message, tool: 'send_message' } });
}
