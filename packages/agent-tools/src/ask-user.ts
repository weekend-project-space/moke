import { z } from 'zod';

import type { RuntimeTool } from '../../agent-runtime/src/index.js';

const askUserSchema = z.object({
  question: z.string().min(1),
  options: z
    .array(
      z.object({
        index: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(2)
    .max(5),
});

export function createAskUserTool(): RuntimeTool<typeof askUserSchema> {
  return {
    name: 'ask_user',
    description: 'Ask the user one question and provide 2 to 5 concrete options for the user to choose from.',
    risk: 'safe',
    schema: askUserSchema,
    async handler() {
      throw new Error('ask_user must be handled by the ReAct runtime pause flow');
    },
  };
}
