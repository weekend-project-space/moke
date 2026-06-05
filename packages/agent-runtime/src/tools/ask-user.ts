import { z } from 'zod';

import type { RuntimeTool } from '../tool-registry.js';

const askUserSchema = z.object({
  question: z.string().min(1),
});

export function createAskUserTool(): RuntimeTool<typeof askUserSchema> {
  return {
    name: 'ask_user',
    description: 'Ask the user for a short clarification.',
    risk: 'safe',
    schema: askUserSchema,
    async handler(input) {
      return {
        question: input.question,
        status: 'mocked',
        answer: 'No user input was requested in this mock runtime.',
      };
    },
  };
}
