# @moke/mcp-client

Small MCP client wrapper for Moke.

Current scope:

- stdio transport only
- tools only
- roots/list support
- no resources, prompts, sampling, remote OAuth, or server-management UI

Example `.moke/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "disabled_tools": ["write_file", "delete_file"]
    }
  }
}
```

MCP tool names are namespaced before they are exposed to the Agent:

```txt
mcp__<server_id>__<tool_name>
```

The server reads `.moke/mcp.json` by default. Set `MOKE_MCP_CONFIG` to point at a different file.

Moke registers MCP tools into the normal runtime `ToolRegistry`, so the ReAct loop sees them the same way it sees local tools. MCP tool input schemas are converted from common JSON Schema fields to Zod for runtime validation.

Supported config fields:

```txt
command            stdio command
args               command arguments
env                command environment variables
enabled            optional, defaults to true
timeout_ms         optional, MCP connect, list, and call timeout
max_output_chars   optional, maximum serialized MCP tool output before truncation
tool_risks         optional, per-tool risk override: safe, write, dangerous
disabled_tools     optional, MCP tool names to hide from the Agent
roots              optional, allowed roots exposed through MCP roots/list
```

If `roots` is omitted, Moke exposes the current workspace as the single MCP root.

Example roots override:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "roots": [
        { "path": ".", "name": "workspace" }
      ]
    }
  }
}
```

`write` and `dangerous` MCP tools are visible in `/api/tools` when enabled, but they are not executed until approval policy is implemented.

The recommended config shape follows the common `mcpServers` object style. Moke still accepts the older internal `servers` array format for compatibility.

## Local Test Tool

This repo includes a local stdio MCP server for manual testing:

```txt
packages/mcp-client/examples/local-mcp-server.mjs
```

The default local config is:

```txt
.moke/mcp.json
```

```json
{
  "mcpServers": {
    "moke_local": {
      "command": "node",
      "args": ["packages/mcp-client/examples/local-mcp-server.mjs"]
    }
  }
}
```

It exposes one MCP tool:

```txt
mcp__moke_local__project_info
```

Try asking the Agent:

```txt
请调用 MCP 工具 project_info 查看当前项目的信息
```
