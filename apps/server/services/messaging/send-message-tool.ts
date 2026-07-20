import { z } from 'zod';

import { ToolExecutionError, type RuntimeTool } from '@moke/agent-runtime';
import type { OutboundContent } from '@moke/messaging-core';
import type { MessagingOutboundMediaPathValidator, MessagingOutboundService } from './messaging-outbound-service.js';

const mediaSchema = z.object({
  path: z.string().min(1),
  caption: z.string().max(2_000).optional(),
});

const fileSchema = mediaSchema.extend({
  name: z.string().max(120).optional(),
});

const sendMessageSchema = z.object({
  text: z.string().max(8_000).optional(),
  images: z.array(mediaSchema).max(4).optional(),
  files: z.array(fileSchema).max(4).optional(),
}).refine((input) => Boolean(input.text?.trim() || input.images?.length || input.files?.length), {
  message: 'text, images, or files is required',
});

export function createSendMessageTool(
  outbound: MessagingOutboundService & Partial<MessagingOutboundMediaPathValidator>,
): RuntimeTool<typeof sendMessageSchema> {
  return {
    name: 'send_message',
    description: 'Send text, images, or files to the current Weixin conversation. Media paths outside the workspace require directory approval.',
    risk: 'dangerous',
    schema: sendMessageSchema,
    async handler(input, context) {
      const run = context.run;
      if (!run || run.origin.kind !== 'messaging' || run.origin.platform !== 'weixin') {
        throw toolError('send_message is only available in the current Weixin conversation', 'MESSAGING_ORIGIN_REQUIRED');
      }
      const contents = toOutboundContents(input);
      if (hasMedia(contents)) {
        await outbound.validateMediaPaths?.(contents);
        if (!context.approveTool) throw toolError('Sending media requires approval', 'TOOL_APPROVAL_REQUIRED');
        const decision = await context.approveTool({
          tool: 'send_message',
          input: toRecord(input),
          risk: 'dangerous',
          callId: context.currentToolCall?.callId,
          reason: 'Send workspace media to the current Weixin conversation',
        });
        if (!decision.approved) throw toolError(decision.message || 'Media sending was rejected', 'TOOL_ACCESS_REJECTED');
      }
      const callId = context.currentToolCall?.callId;
      if (!callId) throw toolError('send_message requires a tool call id', 'TOOL_CALL_ID_REQUIRED');
      const result = await outbound.send({
        binding_id: run.origin.binding_id,
        run_id: run.id,
        idempotency_key: `${run.id}:tool:${callId}`,
        contents,
      });
      const text = input.text?.trim();
      if (text) run.outbound_tool_texts = [...(run.outbound_tool_texts || []), text];
      return { receipts: result.receipts };
    },
  };
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

function toRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolError(message: string, code: string) {
  return new ToolExecutionError(message, { error: { code, message, tool: 'send_message' } });
}
