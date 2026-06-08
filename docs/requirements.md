# Agent Requirements

## 1. Goal

Build a lightweight Agent runtime that uses a simple ReAct execution model, supports basic tools, and can be accessed from both C/S and B/S clients.

The first version should be simple, efficient, and easy to extend. It should not depend on a complex plugin system or a large tool marketplace.

## 2. Product Positioning

The Agent is a local-first assistant runtime.

Primary use cases:

- Chat with the Agent in a session
- Let the Agent inspect project files
- Let the Agent call a small set of tools
- Stream plans, tool calls, results, and final messages to the UI
- Ask the user to choose between clear options when the Agent needs a decision

The Agent should work with:

- Desktop client in C/S mode
- Browser client in B/S mode
- Shared Agent server and runtime

## 3. Non-Goals

The MVP does not include:

- Skill system
- Plugin marketplace
- Multi-agent orchestration
- Complex workflow designer
- Cloud account system
- Fine-grained enterprise ACL
- Long-term semantic memory
- Multi-model routing

These can be added later when the core runtime is stable.

## 4. Architecture

Recommended architecture:

```txt
Vue Client / Tauri Desktop
        |
        | HTTP + SSE
        |
Agent Server
        |
Agent Runtime
        |
ReAct Loop + Tool Executor
        |
LLM / Filesystem / Shell / Other Local Resources
```

The Agent core should not care whether the request comes from a desktop client or browser client. C/S and B/S should share the same HTTP API and event protocol.

## 5. Frontend Requirements

Technology stack:

```txt
Vue 3
Vite
TypeScript
Tauri for desktop packaging
```

The frontend should be a thin client. It sends user messages, subscribes to run events, renders Agent state, and responds to run requests such as `ask_user` choices or cancellation.

Minimum views:

- Session list
- Chat panel
- Tool trace panel
- Ask-user option picker
- Settings panel

Minimum frontend behavior:

- Create a session
- Send a message
- Subscribe to SSE events
- Render streaming assistant output
- Render tool calls and tool results
- Choose an `ask_user` option when the Agent pauses
- Cancel a running Agent task

## 6. Backend Requirements

The backend provides:

- Session management
- Run management
- Agent runtime execution
- SSE event streaming
- Tool registry
- Tool execution
- MCP tool loading
- Runtime limits
- Error reporting
- Local JSON persistence

The backend should expose the API described in `docs/agent-api.md`.

## 7. Agent Runtime

The Agent runtime runs one user request as a `run`.

Basic lifecycle:

```txt
receive message
  -> create run
  -> reason
  -> act
  -> respond
  -> complete
```

The runtime may loop between `reason` and `act` while limits allow:

```txt
reason -> act -> reason -> act -> respond
```

Hard limits must exist from the first version:

```txt
max_steps       default 999
max_tool_calls  default 99
timeout_ms      default 120000
```

## 8. ReAct Model

ReAct means the Agent repeatedly reasons, optionally calls one or more tools, observes tool results, and then answers.

Reasoning responsibilities:

- Understand user intent
- Decide whether tools are needed
- Select candidate tools
- Ask the user to choose an option when the Agent cannot safely decide

Executor responsibilities:

- Enforce runtime limits
- Enforce tool permissions
- Execute tools
- Emit events
- Return observations to the runtime

## 9. Agent States

The MVP uses a small state set:

```txt
idle
reason
act
respond
done
error
```

Run-level status:

```txt
queued
running
awaiting_user
awaiting_approval
completed
failed
cancelled
timeout
```

State changes may be emitted as `agent.state` events.

## 10. Tool System

The MVP supports a small tool registry.

Recommended first tools:

```txt
search
read_file
ask_user
```

Optional later tool:

```txt
write_file
shell
http_request
```

Each tool must define:

```txt
name
description
input schema
risk level
handler
```

Risk levels:

```txt
safe       read-only actions, local search
write      file writes or state changes
dangerous  shell execution, deletion, network access, external service calls
```

Execution policy:

- `safe` tools can run directly
- `ask_user` pauses the run and asks the client to choose from 2 to 5 options
- `write` and `dangerous` tools are delayed until approval policy is implemented

## 11. MCP Tool Layer

MCP is an optional external tool source for the MVP. It should stay behind the existing tool registry instead of changing the ReAct loop.

Current MCP scope:

```txt
client only
stdio transport only
tools
roots/list
```

MCP non-goals for this stage:

```txt
Moke as MCP server
resources
prompts
sampling
OAuth
remote MCP transport
MCP server management UI
```

Configuration:

```txt
default path  .moke/mcp.json
env override  MOKE_MCP_CONFIG
example       packages/mcp-client/mcp.example.json
format        mcpServers object, compatible with older servers array
```

Tool naming:

```txt
mcp__<server_id>__<tool_name>
```

MCP tools are registered as runtime tools with `source.type = "mcp"` and `source.server_id`.

MCP roots are exposed through the client `roots/list` capability. By default, the current workspace is the only root. Per-server config may override roots with a small `roots` array.

The first Tools hardening phase includes:

```txt
GET /api/tools
input schema validation for common JSON Schema fields
tool risk overrides
disabled tools
output truncation
structured MCP tool errors
```

`safe` MCP tools can run directly. `write` and `dangerous` MCP tools are not executed until approval policy is implemented.

## 12. Event Streaming

All runtime progress should be emitted through SSE using a unified event envelope.

Minimum events:

```txt
agent.started
agent.plan
agent.message.delta
tool.call
tool.result
ask_user.required
agent.done
agent.error
```

The event stream is the main contract between the backend and frontend.

## 13. Persistence

The MVP persists:

- Sessions
- Messages
- Runs
- Event trace
- Final responses

Implementation starts with a local JSON file at `.moke/state.json`. SQLite can replace it later if concurrent access or querying becomes important.

## 14. Security And Permissions

The MVP should be conservative by default.

Required protections:

- Workspace path restriction for file tools
- No write or dangerous tools until approval policy exists
- Runtime timeout
- Tool call limit
- Output size limit for tool results
- Basic input validation
- Structured errors

The Agent must not execute arbitrary high-risk actions without policy checks.

## 15. API Requirements

The API should follow `docs/agent-api.md`.

Minimum endpoints:

```txt
POST /api/sessions
POST /api/sessions/:session_id/messages
GET  /api/runs/:run_id/events
POST /api/runs/:run_id/respond
```

Optional but useful:

```txt
GET /api/sessions
GET /api/sessions/:session_id
GET /api/tools
```

## 16. Implementation Milestones

### Milestone 1: Protocol And Skeleton

- Finalize API document
- Define event types
- Create backend project skeleton
- Create frontend project skeleton
- Create shared TypeScript types

### Milestone 2: Agent Runtime MVP

- Implement session creation
- Implement run creation
- Implement event streaming
- Implement manual ReAct loop
- Emit runtime events

### Milestone 3: Tool Runtime

- Implement tool registry
- Implement `search`
- Implement `read_file`
- Implement `ask_user`
- Implement runtime limits

### Milestone 4: Real Model Integration

- Connect LLM provider
- Feed tool observations back into the runtime
- Generate final assistant responses

### Milestone 5: Vue UI

- Implement session list
- Implement chat panel
- Implement streaming output
- Implement tool trace panel
- Implement ask-user option picker

### Milestone 6: Desktop Shell

- Add Tauri wrapper
- Connect desktop UI to local Agent server
- Add local configuration
- Package basic desktop build

## 17. Open Questions

- Should the Agent server always run locally, or can it also run remotely?
- Should `shell` be enabled in MVP, or delayed until file tools are stable?
- When should persistence move from JSON to SQLite?
- Should approvals be per action, per run, or configurable by risk level once write/shell tools exist?
- Should B/S mode support multiple users in the first version?
