# @moke/mcp-client

Small MCP client wrapper for Moke.

Current scope:

- stdio transport only
- tools only
- roots/list support
- no resources, prompts, sampling, or remote OAuth

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

Moke starts trusted MCP servers lazily for the current Session workspace. Each Run receives a scoped `ToolRegistry` snapshot built from that workspace's discovered tools, so tool catalogs, process working directories, and roots do not leak across workspaces. MCP tool input schemas are converted from common JSON Schema fields to Zod for runtime validation.

Supported config fields:

```txt
command            stdio command
args               command arguments
env                command environment variables
enabled            optional, defaults to true
timeout_ms         optional, MCP connect, list, and call timeout
max_output_chars   optional, maximum serialized MCP tool output before truncation
disabled_tools     optional, MCP tool names to hide from the Agent
read_only_tools    optional, original MCP tool names that skip tool approval
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

MCP tools use `approval: "required"` by default. Only original tool names explicitly listed in a server's `read_only_tools` use `approval: "none"`; disabled tools are never exposed to the Agent.

Local stdio servers must be explicitly trusted in MCP settings before Moke executes their configured command. Trust is bound to a SHA-256 fingerprint of the normalized server configuration. Changing executable configuration, roots, environment, or tool policy invalidates the previous trust; toggling `enabled` does not.

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
