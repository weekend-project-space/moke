import { z } from 'zod';

import { ToolExecutionError, type RuntimeRun, type RuntimeTool } from '@moke/agent-runtime';
import type { MessagingPlatform, OutboundContent } from '@moke/messaging-core';
import type { MessagingToolBackend } from './messaging-tool-backend.js';

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
    async handler(input, context) {
      const run = context.run;
      if (!run) throw toolError('send_message requires an active run', 'RUN_REQUIRED');
      const bindingId = resolveBindingId(input.platform, run, backend);
      const contents = toOutboundContents(input);
      const access = {
        workspaceRoot: context.workspace,
        approvedRoots: context.workspaceRoots?.(),
      };
      if (hasMedia(contents)) await backend.validateMediaPaths(contents, access);
      const callId = context.currentToolCall?.callId;
      if (!callId) throw toolError('send_message requires a tool call id', 'TOOL_CALL_ID_REQUIRED');
      const result = await backend.send({
        binding_id: bindingId,
        run_id: run.id,
        idempotency_key: `${run.id}:tool:${callId}`,
        contents,
      }, access);
      return { receipts: result.receipts };
    },
  };
}

function resolveBindingId(platform: MessagingPlatform | undefined, run: RuntimeRun, backend: MessagingToolBackend) {
  if (run.origin.kind === 'messaging' && (!platform || platform === run.origin.platform)) {
    return run.origin.binding_id;
  }
  if (!platform) {
    throw toolError('send_message requires platform outside an external messaging conversation', 'MESSAGING_TARGET_REQUIRED');
  }
  const target = backend.resolveTarget({ platform, sessionId: run.session_id });
  if (target.status === 'resolved') return target.bindingId;
  if (target.status === 'ambiguous') {
    throw toolError(
      `Multiple ${platform} messaging targets are available (${target.count}); a unique target is required`,
      'MESSAGING_TARGET_AMBIGUOUS',
    );
  }
  throw toolError(`No messaging target is available for ${platform}`, 'MESSAGING_TARGET_NOT_FOUND');
}

function toOutboundContents(input: z.infer<typeof sendMessageSchema>): OutboundContent[] {
  return [
    ...(input.text?.trim() ? [{ type: 'text' as const, text: input.text.trim() }] : []),
    ...(input.images || []).map((image) => ({ type: 'image' as const, path: image.path, ...(image.caption ? { caption: image.caption } : {}) })),
    ...(input.files || []).map((file) => ({ type: 'file' as const, path: file.path, ...(file.name ? { name: file.name } : {}), ...(file.caption ? { caption: file.caption } : {}) })),
  ];
}

function hasMedia(contents: OutboundContent[]) {
  return contents.some((content) => content.type !== 'text');
}

function toolError(message: string, code: string) {
  return new ToolExecutionError(message, { error: { code, message, tool: 'send_message' } });
}
