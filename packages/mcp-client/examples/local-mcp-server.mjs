import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const workspace = process.cwd();

const server = new McpServer({
  name: 'moke-local-tools',
  version: '0.1.0',
});

server.registerTool(
  'project_info',
  {
    title: 'Project Info',
    description: 'Return basic read-only information about the current Moke workspace.',
    inputSchema: {
      topic: z.string().optional().describe('Optional topic or reason for requesting project information.'),
    },
  },
  async ({ topic }) => {
    const packageJson = await readPackageJson();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              tool: 'project_info',
              workspace,
              topic: topic || 'general',
              package: {
                name: packageJson.name,
                version: packageJson.version,
                type: packageJson.type,
                scripts: Object.keys(packageJson.scripts || {}),
                dependencies: Object.keys(packageJson.dependencies || {}),
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());

async function readPackageJson() {
  const raw = await readFile(join(workspace, 'package.json'), 'utf8');
  return JSON.parse(raw);
}
