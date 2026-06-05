# Agent Requirements

## 1. Goal

Build a lightweight Agent runtime that uses a PreAct execution model, supports basic tools, and can be accessed from both C/S and B/S clients.

The first version should be simple, efficient, and easy to extend. It should not depend on a complex plugin system or a large tool marketplace.

## 2. Product Positioning

The Agent is a local-first assistant runtime.

Primary use cases:

- Chat with the Agent in a session
- Let the Agent inspect project files
- Let the Agent call a small set of tools
- Stream plans, tool calls, results, and final messages to the UI
- Ask the user for approval before risky actions

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
PreAct Engine + Tool Executor
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
Pinia
Tauri for desktop packaging
```

The frontend should be a thin client. It sends user messages, subscribes to run events, renders Agent state, and handles approvals.

Minimum views:

- Session list
- Chat panel
- Agent plan panel
- Tool trace panel
- Approval dialog
- Settings panel

Minimum frontend behavior:

- Create a session
- Send a message
- Subscribe to SSE events
- Render streaming assistant output
- Render tool calls and tool results
- Approve or reject risky actions
- Cancel a running Agent task

## 6. Backend Requirements

The backend provides:

- Session management
- Run management
- Agent runtime execution
- SSE event streaming
- Tool registry
- Tool execution
- Approval handling
- Runtime limits
- Error reporting

The backend should expose the API described in `docs/agent-api.md`.

## 7. Agent Runtime

The Agent runtime runs one user request as a `run`.

Basic lifecycle:

```txt
receive message
  -> create run
  -> preact
  -> act
  -> respond
  -> complete
```

The runtime may loop between `preact` and `act` while limits allow:

```txt
preact -> act -> preact -> act -> respond
```

Hard limits must exist from the first version:

```txt
max_steps       default 6
max_tool_calls  default 8
timeout_ms      default 120000
```

## 8. PreAct Model

PreAct means the Agent plans before acting.

The PreAct phase should produce structured output:

```json
{
  "intent": "code_review",
  "risk": "safe",
  "steps": [
    "Scan project structure",
    "Read important files",
    "Identify issues",
    "Write review"
  ],
  "tools": ["search", "read_file"]
}
```

The runtime should validate this output before executing tools.

PreAct responsibilities:

- Understand user intent
- Decide whether tools are needed
- Produce a short plan
- Estimate risk
- Select candidate tools
- Decide whether user approval is required

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
preact
act
respond
done
error
```

Run-level status:

```txt
queued
running
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
write_file
shell
ask_user
```

Optional later tool:

```txt
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

Approval policy:

- `safe` tools can run directly
- `write` tools may require approval depending on configuration
- `dangerous` tools require approval by default

## 11. Event Streaming

All runtime progress should be emitted through SSE using a unified event envelope.

Minimum events:

```txt
agent.started
agent.plan
agent.message.delta
tool.call
tool.result
approval.required
agent.done
agent.error
```

The event stream is the main contract between the backend and frontend.

## 12. Persistence

The MVP should persist:

- Sessions
- Messages
- Runs
- Event trace
- Tool call summaries
- Final responses

Implementation can start with SQLite or local JSON files. SQLite is preferred if concurrent access or querying is needed.

## 13. Security And Permissions

The MVP should be conservative by default.

Required protections:

- Workspace path restriction for file tools
- Approval before write or dangerous actions
- Runtime timeout
- Tool call limit
- Output size limit for tool results
- Basic input validation
- Structured errors

The Agent must not execute arbitrary high-risk actions without policy checks.

## 14. API Requirements

The API should follow `docs/agent-api.md`.

Minimum endpoints:

```txt
POST /api/sessions
POST /api/sessions/:session_id/messages
GET  /api/runs/:run_id/events
POST /api/runs/:run_id/approve
POST /api/runs/:run_id/cancel
```

Optional but useful:

```txt
GET /api/sessions
GET /api/sessions/:session_id
```

## 15. Implementation Milestones

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
- Implement PreAct output schema
- Emit mocked Agent events

### Milestone 3: Tool Runtime

- Implement tool registry
- Implement `search`
- Implement `read_file`
- Implement `write_file`
- Implement approval flow
- Implement runtime limits

### Milestone 4: Real Model Integration

- Connect LLM provider
- Validate structured PreAct output
- Feed tool observations back into the runtime
- Generate final assistant responses

### Milestone 5: Vue UI

- Implement session list
- Implement chat panel
- Implement streaming output
- Implement plan and tool trace panels
- Implement approval dialog

### Milestone 6: Desktop Shell

- Add Tauri wrapper
- Connect desktop UI to local Agent server
- Add local configuration
- Package basic desktop build

## 16. Open Questions

- Should the Agent server always run locally, or can it also run remotely?
- Should `shell` be enabled in MVP, or delayed until file tools are stable?
- Should persistence use SQLite from the start?
- Should approvals be per action, per run, or configurable by risk level?
- Should B/S mode support multiple users in the first version?
