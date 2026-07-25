import { z } from 'zod';

import type { ToolRegistry } from '@moke/agent-runtime';

export const ASK_USER_TOOL_NAME = 'ask_user';

export const askUserSchema = z.object({
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        label: z.string().min(1),
      }),
    )
    .min(2)
    .max(5),
});

type RuntimeToolSpec = ReturnType<ToolRegistry['list']>[number];

export type AgentToolSpec = RuntimeToolSpec;

export const askUserTool: AgentToolSpec = {
  name: ASK_USER_TOOL_NAME,
  description: 'Pause the current run to ask the user one question with 2 to 5 concrete options.',
  schema: askUserSchema,
};

export function normalizeAskOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [
      { id: 'continue', label: '继续' },
      { id: 'cancel', label: '取消' },
    ];
  }

  const options = value
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const option = item as Record<string, unknown>;
      const label = typeof option.label === 'string' ? option.label.trim() : '';
      if (!label) return null;
      const rawId = typeof option.id === 'string' ? option.id.trim() : '';

      return {
        id: rawId || `option_${index + 1}`,
        label,
      };
    })
    .filter((option): option is { id: string; label: string } => Boolean(option))
    .slice(0, 5);

  if (options.length >= 2) return options;

  return [
    { id: 'yes', label: '是' },
    { id: 'no', label: '否' },
  ];
}

export function createStepLimitContent(hasObservation: boolean) {
  if (hasObservation) {
    return '我已经做了一些检查，但这次没有在步骤限制内形成完整结论。可以继续追问，我会基于已有线索接着处理。';
  }

  return '我这次没有在步骤限制内完成回答。可以把问题再缩小一点，或让我继续处理。';
}
