# @moke/mcp-client

Small MCP client wrapper for Moke.

Current scope:

- stdio transport only
- tools only
- no resources, prompts, sampling, remote OAuth, or server-management UI

Example `.moke/mcp.json`:

```json
{
  "servers": [
    {
      "id": "filesystem",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "timeout_ms": 30000
    }
  ]
}
```

MCP tool names are namespaced before they are exposed to the Agent:

```txt
mcp__<server_id>__<tool_name>
```

The server reads `.moke/mcp.json` by default. Set `MOKE_MCP_CONFIG` to point at a different file.

Moke registers MCP tools into the normal runtime `ToolRegistry`, so the ReAct loop sees them the same way it sees local tools. The current MVP accepts MCP tool input as a generic JSON object and includes the original MCP input schema in the tool description for the model.

## Local Test Tool

This repo includes a local stdio MCP server for manual testing:

```txt
packages/mcp-client/examples/local-mcp-server.mjs
```

The default local config is:

```txt
.moke/mcp.json
```

It exposes one MCP tool:

```txt
mcp__moke_local__project_info
```

Try asking the Agent:

```txt
请调用 MCP 工具 project_info 查看当前项目的信息
```
