import { z } from 'zod';

import type { RuntimeTool, SystemBackend } from '../../agent-runtime/src/index.js';

const MAX_RESULTS = 20;

const searchSchema = z.object({
  query: z.string().min(1),
});

export function createSearchTool(system: SystemBackend): RuntimeTool<typeof searchSchema> {
  return {
    name: 'search',
    description: 'Search file names and text inside the workspace.',
    risk: 'safe',
    schema: searchSchema,
    async handler(input) {
      const [globResult, grepResult] = await Promise.all([
        system.glob(`**/*${input.query}*`),
        system.grep(input.query, { mode: 'content' }),
      ]);
      const results = [
        ...globResult.matches.map((match) => ({
          path: match.path,
          match_type: 'filename',
          snippet: match.path,
        })),
        ...grepResult.matches.map((match) => ({
          path: match.path,
          match_type: 'content',
          line: match.line,
          snippet: match.text,
        })),
      ];
      const limitedResults = results.slice(0, MAX_RESULTS);

      return {
        query: input.query,
        count: limitedResults.length,
        results: limitedResults,
        matches: [...new Set(limitedResults.map((match) => match.path))],
      };
    },
  };
}
