import { z } from 'zod';

const safeId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const nonEmptyText = z.string().trim().min(1);

export const idParamsSchema = z.object({ id: safeId }).strict();
export const attachmentParamsSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const listSessionsQuerySchema = z.object({
  include_archived: z.enum(['true', 'false']).optional().default('false'),
}).strict();

const approvalModeSchema = z.enum(['manual', 'ai_review', 'auto_approve']);
const scheduledTaskStatusSchema = z.enum(['enabled', 'paused']);

const createSessionEnvironmentInputSchema = z.object({
  approval_mode: approvalModeSchema.optional(),
  workspace: z.object({ root: nonEmptyText.max(2000) }).strict().optional(),
}).strict();

const mutableSessionEnvironmentInputSchema = z.object({
  approval_mode: approvalModeSchema.optional(),
}).strict();

export const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  env: createSessionEnvironmentInputSchema.optional(),
}).strict();

export const updateSessionEnvironmentSchema = mutableSessionEnvironmentInputSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one environment field is required' },
);

export const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one session field is required',
});

const imageUploadSchema = z.object({
  id: safeId.optional(),
  kind: z.literal('image').optional(),
  name: z.string().max(120).optional(),
  mime_type: nonEmptyText.max(100),
  data_url: nonEmptyText,
}).strict();

const runOptionsSchema = z.object({
  stream: z.boolean().optional(),
  max_steps: z.number().int().positive().max(1000).optional(),
  max_tool_calls: z.number().int().nonnegative().max(200).optional(),
  timeout_ms: z.number().int().positive().max(3600000).optional(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max', 'ultra']).optional(),
}).strict();

export const forkSessionSchema = z.object({
  message_id: nonEmptyText.max(200),
  mode: z.literal('after').optional().default('after'),
}).strict();

export const sendMessageSchema = z.object({
  message: z.object({
    role: z.literal('user').optional(),
    content: z.string().default(''),
    attachments: z.array(imageUploadSchema).max(4).optional(),
  }).strict(),
  env: mutableSessionEnvironmentInputSchema.optional(),
  options: runOptionsSchema.optional().default({}),
}).strict();

export const listScheduledTasksQuerySchema = z.object({
  status: scheduledTaskStatusSchema.optional(),
}).strict();

export const createScheduledTaskSchema = z.object({
  name: nonEmptyText.max(120),
  prompt: nonEmptyText.max(20_000),
  cron: nonEmptyText.max(200),
  timezone: nonEmptyText.max(100),
  workspace_root: nonEmptyText.max(2000),
  approval_mode: approvalModeSchema,
  status: scheduledTaskStatusSchema.optional(),
}).strict();

export const updateScheduledTaskSchema = createScheduledTaskSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one task field is required' },
);

export const runRespondSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choose'),
    request_id: safeId,
    option_id: nonEmptyText.max(200),
  }).strict(),
  z.object({
    type: z.literal('approve'),
    request_id: safeId,
    decision: z.enum(['approved', 'rejected']),
    scope: z.enum(['once', 'session', 'persistent']).optional(),
    message: z.string().max(1000).optional(),
  }).strict(),
  z.object({
    type: z.literal('cancel'),
    reason: z.string().max(1000).optional(),
  }).strict(),
]);

export const providerInputSchema = z.object({
  id: safeId.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  type: z.enum(['openai-compatible', 'openai-responses']).optional(),
  apiKey: z.string().max(2000).optional(),
  apiBaseUrl: nonEmptyText.max(2000).optional(),
  maxRetries: z.number().int().min(0).max(6).optional(),
  model: nonEmptyText.max(200).optional(),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max', 'ultra']).optional(),
  reasoningProvider: z.enum(['none', 'llama.cpp']).optional(),
  showRawReasoning: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(3600000).optional(),
}).strict();

export const runtimeSettingsSchema = z.object({
  activeProviderId: safeId.optional(),
  providers: z.array(providerInputSchema).optional(),
}).strict();

export const skillDraftSchema = z.object({
  id: safeId.optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  enabled: z.boolean().optional(),
  currentId: safeId.optional(),
}).strict();

export const skillStatusSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const mcpSettingsSchema = z.object({
  raw: z.string(),
}).strict();

export const revokePermissionSchema = z.object({
  path: nonEmptyText.max(4096),
}).strict();

export const browserRespondSchema = z.object({
  id: safeId,
  ok: z.boolean().optional().default(true),
  result: z.record(z.string(), z.unknown()).optional().default({}),
  error: z.string().max(2000).optional(),
}).strict();

export const messagingConnectionUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  allowedUserIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  cardTemplateId: z.string().trim().max(300).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one connection setting is required');

export const weixinLoginStartSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  connectionId: safeId.optional(),
}).strict();

export const weixinLoginUpdateSchema = z.object({
  code: z.string().trim().regex(/^\d{1,12}$/),
}).strict();

export const feishuLoginStartSchema = z.object({
  domain: z.enum(['feishu', 'lark']).optional().default('feishu'),
}).strict();

export const dingtalkLoginStartSchema = z.object({}).strict();

export const messagingConnectionCreateSchema = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('dingtalk'),
    credentials: z.object({
      clientId: z.string().trim().min(1).max(200),
      clientSecret: z.string().trim().min(1).max(2000),
      allowedUserIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
      cardTemplateId: z.string().trim().max(300).optional(),
    }).strict(),
  }).strict(),
  z.object({
    platform: z.literal('feishu'),
    credentials: z.object({
      appId: z.string().trim().min(1).max(200),
      appSecret: z.string().trim().min(1).max(2000),
      domain: z.enum(['feishu', 'lark']).optional().default('feishu'),
    }).strict(),
  }).strict(),
]);
