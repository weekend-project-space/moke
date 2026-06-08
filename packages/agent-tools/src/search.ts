import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { RuntimeTool } from '../../agent-runtime/src/index.js';

const MAX_FILES = 80;
const MAX_RESULTS = 20;
const MAX_SNIPPET_LENGTH = 160;
const IGNORED_DIRS = new Set(['.git', '.agents', '.codex', 'node_modules', 'target', 'dist', '.vite']);

type SearchMatch = {
  path: string;
  match_type: 'filename' | 'content';
  line?: number;
  snippet?: string;
};

async function walk(dir: string, files: string[] = []) {
  if (files.length >= MAX_FILES) return files;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else {
      files.push(fullPath);
    }

    if (files.length >= MAX_FILES) break;
  }

  return files;
}

const searchSchema = z.object({
  query: z.string().min(1),
});

function normalizeSnippet(line: string) {
  return line.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_LENGTH);
}

function findContentMatches(content: string, query: string, relativePath: string) {
  const matches: SearchMatch[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.toLowerCase().includes(query)) continue;

    matches.push({
      path: relativePath,
      match_type: 'content',
      line: index + 1,
      snippet: normalizeSnippet(line),
    });

    if (matches.length >= 2) break;
  }

  return matches;
}

export function createSearchTool(): RuntimeTool<typeof searchSchema> {
  return {
    name: 'search',
    description: 'Search file names and text inside the workspace.',
    risk: 'safe',
    schema: searchSchema,
    async handler(input, context) {
      const query = input.query.toLowerCase();
      const files = await walk(context.workspace);
      const results: SearchMatch[] = [];

      for (const file of files) {
        const relative = path.relative(context.workspace, file);
        if (relative.toLowerCase().includes(query)) {
          results.push({
            path: relative,
            match_type: 'filename',
            snippet: relative,
          });
        }

        const info = await stat(file);
        if (info.size <= 128_000) {
          try {
            const content = await readFile(file, 'utf8');
            if (!content.includes('\u0000')) {
              results.push(...findContentMatches(content, query, relative));
            }
          } catch {
            // Ignore binary or unreadable files.
          }
        }

        if (results.length >= MAX_RESULTS) break;
      }

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
