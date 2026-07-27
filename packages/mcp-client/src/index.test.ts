import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMcpConfigText } from './index.js';

test('MCP config defaults read_only_tools and accepts explicit original tool names', () => {
  const config = parseMcpConfigText(JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'node',
        args: ['server.js'],
        read_only_tools: ['read_file'],
        disabled_tools: ['delete_file'],
      },
    },
  }));

  assert.deepEqual(config.servers[0]?.read_only_tools, ['read_file']);
  assert.deepEqual(config.servers[0]?.disabled_tools, ['delete_file']);
});

test('MCP config defaults read_only_tools to an empty list', () => {
  const config = parseMcpConfigText(JSON.stringify({
    servers: [{ id: 'local', transport: 'stdio', command: 'node' }],
  }));

  assert.deepEqual(config.servers[0]?.read_only_tools, []);
});
