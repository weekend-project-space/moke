# Agent API Interface

This document describes the first-version interface for an Agent that uses a lightweight ReAct runtime, supports basic tools, and can be consumed by both C/S and B/S clients.

## 1. Overview

The client sends user input through HTTP. The Agent server creates a run and streams runtime events through SSE.

```txt
Client
  -> POST message
  <- run_id
  -> subscribe events
  <- agent events
```

Default transport:

- HTTP: create sessions, send messages, respond to run requests
- SSE: stream Agent runtime events
- WebSocket: optional future replacement, using the same event schema

## 2. Base Conventions

Base path:

```txt
/api
```

Content type:

```txt
application/json
```

Time format:

```txt
ISO 8601 UTC, for example 2026-06-04T10:00:00Z
```

ID prefixes:

```txt
sess_  session id
run_   agent run id
msg_   message id
evt_   event id
call_  tool call id
ask_   ask_user request id
apv_   approval id
```

## 3. Core Concepts

### Session

A session represents one conversation or task workspace.

```json
{
  "id": "sess_01HXX",
  "title": "Code review",
  "created_at": "2026-06-04T10:00:00Z",
  "updated_at": "2026-06-04T10:10:00Z"
}
```

### Run

A run represents one Agent execution triggered by a user message.

```json
{
  "id": "run_01HXX",
  "session_id": "sess_01HXX",
  "status": "running",
  "created_at": "2026-06-04T10:00:00Z"
}
```

Run status:

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

### Risk Level

```txt
safe       read-only actions, local search
write      file writes or state changes
dangerous  shell execution, deletion, network access, external service calls
```

## 4. HTTP Endpoints

### 4.1 Create Session

```txt
POST /api/sessions
```

Request:

```json
{
  "title": "Code review",
  "metadata": {
    "workspace": "/path/to/project"
  }
}
```

Response:

```json
{
  "session": {
    "id": "sess_01HXX",
    "title": "Code review",
    "created_at": "2026-06-04T10:00:00Z",
    "updated_at": "2026-06-04T10:00:00Z"
  }
}
```

### 4.2 List Sessions

```txt
GET /api/sessions
```

Query params:

```txt
limit   optional, default 20
cursor  optional
```

Response:

```json
{
  "sessions": [
    {
      "id": "sess_01HXX",
      "title": "Code review",
      "created_at": "2026-06-04T10:00:00Z",
      "updated_at": "2026-06-04T10:10:00Z"
    }
  ],
  "next_cursor": null
}
```

### 4.3 Get Session

```txt
GET /api/sessions/:session_id
```

Response:

```json
{
  "session": {
    "id": "sess_01HXX",
    "title": "Code review",
    "created_at": "2026-06-04T10:00:00Z",
    "updated_at": "2026-06-04T10:10:00Z"
  },
  "messages": [
    {
      "id": "msg_01",
      "role": "user",
      "content": "Help me review this project",
      "created_at": "2026-06-04T10:00:00Z"
    }
  ]
}
```

### 4.4 Send Message

Creates a new Agent run.

```txt
POST /api/sessions/:session_id/messages
```

Request:

```json
{
  "message": {
    "role": "user",
    "content": "Help me review this project"
  },
  "options": {
    "stream": true,
    "max_steps": 999,
    "max_tool_calls": 99,
    "timeout_ms": 120000
  }
}
```

Request fields:

```txt
message.content   required
options           optional runtime limits
```

Response:

```json
{
  "run_id": "run_01HXX",
  "session_id": "sess_01HXX",
  "events_url": "/api/runs/run_01HXX/events"
}
```

### 4.5 Stream Run Events

```txt
GET /api/runs/:run_id/events
```

Transport:

```txt
text/event-stream
```

Each SSE message uses the event type as the SSE `event` field and the JSON envelope as `data`.

Example:

```txt
event: agent.plan
data: {"id":"evt_02","seq":2,"type":"agent.plan","run_id":"run_01HXX","session_id":"sess_01HXX","ts":"2026-06-04T10:00:02Z","payload":{"intent":"code_review"}}
```

The client should reconnect with `Last-Event-ID` when the connection drops.

### 4.6 Respond to Run

```txt
POST /api/runs/:run_id/respond
```

Choose an `ask_user` option:

```json
{
  "type": "choose",
  "request_id": "ask_01",
  "option_id": "frontend"
}
```

### 4.7 List Tools

```txt
GET /api/tools
```

Response:

```json
{
  "tools": [
    {
      "name": "mcp__moke_local__project_info",
      "original_name": "project_info",
      "description": "Return basic read-only information about the current Moke workspace.",
      "risk": "safe",
      "source": {
        "type": "mcp",
        "server_id": "moke_local"
      },
      "input_schema": {
        "type": "object",
        "properties": {
          "topic": {
            "type": "string"
          }
        }
      }
    }
  ]
}
```

Future approval response:

```json
{
  "type": "approve",
  "request_id": "apv_01",
  "decision": "rejected",
  "scope": "session",
  "message": "Do not modify this file"
}
```

Cancel the run:

```json
{
  "type": "cancel",
  "reason": "User cancelled"
}
```

Response:

```json
{
  "run_id": "run_01HXX",
  "request_id": "ask_01",
  "status": "running"
}
```

## 5. Event Envelope

All runtime events use the same envelope.

```json
{
  "id": "evt_01HXX",
  "seq": 1,
  "type": "agent.started",
  "run_id": "run_01HXX",
  "session_id": "sess_01HXX",
  "ts": "2026-06-04T10:00:00Z",
  "payload": {}
}
```

Fields:

```txt
id          unique event id
seq         monotonically increasing sequence within a run
type        event type
run_id      run id
session_id  session id
ts          event timestamp
payload     event-specific body
```

## 6. Event Types

### 6.1 agent.started

Emitted when a run starts.

```json
{
  "type": "agent.started",
  "payload": {
    "input": "Help me review this project"
  }
}
```

### 6.2 agent.plan

Emitted after runtime setup.

```json
{
  "type": "agent.plan",
  "payload": {
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
}
```

### 6.3 agent.state

Optional event for state changes.

```json
{
  "type": "agent.state",
  "payload": {
    "state": "act"
  }
}
```

Supported simple states:

```txt
reason
act
respond
```

### 6.4 agent.message.delta

Emitted for streaming assistant text.

```json
{
  "type": "agent.message.delta",
  "payload": {
    "content": "I will inspect the project structure first."
  }
}
```

### 6.5 agent.message.done

Emitted when one assistant message is complete.

```json
{
  "type": "agent.message.done",
  "payload": {
    "message": {
      "id": "msg_02",
      "role": "assistant",
      "content": "I found two potential issues.",
      "created_at": "2026-06-04T10:01:00Z"
    }
  }
}
```

### 6.6 tool.call

Emitted before a tool is executed.

```json
{
  "type": "tool.call",
  "payload": {
    "call_id": "call_01",
    "tool": "search",
    "input": {
      "query": "package.json"
    },
    "risk": "safe",
    "source": {
      "type": "local"
    }
  }
}
```

MCP tools use the same event shape with MCP source metadata:

```json
{
  "type": "tool.call",
  "payload": {
    "call_id": "call_02",
    "tool": "mcp__filesystem__read_file",
    "input": {
      "path": "README.md"
    },
    "risk": "safe",
    "source": {
      "type": "mcp",
      "server_id": "filesystem"
    }
  }
}
```

### 6.7 tool.result

Emitted after a tool completes.

```json
{
  "type": "tool.result",
  "payload": {
    "call_id": "call_01",
    "status": "ok",
    "duration_ms": 42,
    "output": {
      "matches": ["package.json"]
    }
  }
}
```

Tool result status:

```txt
ok
error
denied
timeout
```

### 6.8 approval.required

Emitted when the Agent needs user approval before continuing. The first supported approval kind is workspace path access.

```json
{
  "type": "approval.required",
  "payload": {
    "approval_id": "apv_01",
    "kind": "tool",
    "reason": "Agent wants to modify files",
    "risk": "write",
    "action": {
      "tool": "write_file",
      "input": {
        "path": "src/main.ts"
      }
    }
  }
}
```

Workspace path approval:

```json
{
  "type": "approval.required",
  "payload": {
    "approval_id": "apv_02",
    "kind": "workspace_path",
    "reason": "Command path requires approval: E:\\notes\\a.md",
    "risk": "write",
    "action": {
      "tool": "write_file",
      "input": {
        "path": "E:\\notes\\a.md"
      }
    },
    "path": "E:\\notes\\a.md",
    "suggested_root": "E:\\notes",
    "created_at": "2026-06-04T10:01:00Z"
  }
}
```

The client should keep `approval.required` in `eventTypes`; do not add a separate workspace event type. Use `payload.kind` to choose the UI copy and behavior.

Approval scope:

```txt
once        allow only the current retry
session     allow for the current server process
persistent  allow across restarts by writing .moke/permissions.json
```

The current implementation treats `once` and `session` as in-memory permissions. Only `persistent` is stored.

### 6.9 ask_user.required

Emitted when the Agent needs the user to choose one option before continuing.

```json
{
  "type": "ask_user.required",
  "payload": {
    "ask_id": "ask_01",
    "call_id": "call_01",
    "question": "你希望我优先检查前端还是运行时？",
    "options": [
      {
        "id": "frontend",
        "label": "先检查前端"
      },
      {
        "id": "runtime",
        "label": "先检查运行时"
      }
    ],
    "created_at": "2026-06-04T10:01:00Z"
  }
}
```

### 6.10 agent.done

Emitted when the run completes.

```json
{
  "type": "agent.done",
  "payload": {
    "status": "completed",
    "usage": {
      "steps": 4,
      "tool_calls": 3,
      "duration_ms": 8500
    }
  }
}
```

### 6.11 agent.error

Emitted when the run fails.

```json
{
  "type": "agent.error",
  "payload": {
    "code": "TOOL_EXECUTION_FAILED",
    "message": "Tool execution failed",
    "details": {
      "tool": "search",
      "call_id": "call_01"
    }
  }
}
```

## 7. Error Response

HTTP errors use this format:

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session not found",
    "details": {
      "session_id": "sess_missing"
    }
  }
}
```

Common error codes:

```txt
BAD_REQUEST
SESSION_NOT_FOUND
RUN_NOT_FOUND
TOOL_NOT_ALLOWED
APPROVAL_REQUIRED
APPROVAL_NOT_FOUND
RUN_CANCELLED
RUN_TIMEOUT
RATE_LIMITED
INTERNAL_ERROR
```

## 8. MCP Configuration

MCP is optional. When an MCP config file exists, the server connects enabled stdio MCP servers during startup and registers their tools into the normal runtime tool registry.

Default config path:

```txt
.moke/mcp.json
```

Override:

```txt
MOKE_MCP_CONFIG=/path/to/mcp.json
```

Example:

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

`mcpServers` keys are used as server ids. If `command` is present, the server is treated as a stdio MCP server. The older internal `servers` array format is still accepted for compatibility.

Exposed tool names:

```txt
mcp__<server_id>__<tool_name>
```

Current MCP scope:

```txt
stdio transport only
tools
roots/list
no resources, prompts, sampling, OAuth, remote MCP, or MCP server management UI
```

MCP tool behavior:

```txt
input_schema       converted to runtime validation for common JSON Schema fields
max_output_chars   truncates serialized tool output
tool_risks         marks MCP tools as safe, write, or dangerous
disabled_tools     hides configured tools from the Agent
roots              optional allowed root paths exposed through roots/list
```

If `roots` is omitted, the server exposes the current workspace as the single MCP root. Root paths are returned to MCP servers as `file://` URIs.

Current JSON Schema validation support:

```txt
object
string
number
integer
boolean
array
required
enum
```

## 9. Frontend Integration

Minimal Vue client flow:

```ts
async function sendMessage(sessionId: string, content: string) {
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: { role: "user", content },
      options: { stream: true, max_steps: 999 },
    }),
  });

  return response.json();
}

function subscribeRun(eventsUrl: string, onEvent: (event: any) => void) {
  const source = new EventSource(eventsUrl);

  source.onmessage = (message) => {
    onEvent(JSON.parse(message.data));
  };

  const eventTypes = [
    "agent.started",
    "agent.plan",
    "agent.state",
    "agent.message.delta",
    "agent.message.done",
    "tool.call",
    "tool.result",
    "ask_user.required",
    "approval.required",
    "agent.done",
    "agent.error",
  ];

  for (const type of eventTypes) {
    source.addEventListener(type, (message) => {
      onEvent(JSON.parse((message as MessageEvent).data));
    });
  }

  return () => source.close();
}
```

## 10. Minimum MVP Contract

For the first implementation, these endpoints and events are enough:

Endpoints:

```txt
POST /api/sessions
POST /api/sessions/:session_id/messages
GET  /api/runs/:run_id/events
POST /api/runs/:run_id/respond
GET  /api/tools
```

Events:

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

Hard runtime limits:

```txt
max_steps       default 99
max_tool_calls  default 99
timeout_ms      default 120000
```
