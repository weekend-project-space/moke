# Tool Display Renderers

This document describes how tool calls are grouped and rendered in the client conversation timeline.

## Two Layers

The UI uses two separate concepts:

- `toolCategory`: controls the main row icon/action semantics.
- `renderer`: controls the expanded detail view.

## Tool Categories

`toolCategory` has three values:

| Category | Meaning | Example label |
| --- | --- | --- |
| `view` | Read-only inspection | `查看文件`, `查看目录`, `查看页面` |
| `change` | Mutates files, browser state, or UI state | `变更文件`, `变更页面`, `变更界面` |
| `run` | Runs commands, searches, waits, or generic tools | `运行命令`, `运行搜索`, `运行工具` |

## Renderers

### `directory`

Used by:

- `ls`

Main row:

```text
▸ 查看目录 · .
```

Expanded view:

```text
▾ 查看目录 · .

   ┌────────────────────────────────────┐
   │ agents/
   │ apps/
   │ docs/
   │ package.json
   │                                    │
   │ 4 项                         成功 │
   └────────────────────────────────────┘
   JSON
```

Rules:

- Directory entries are shown in a light console-style block.
- Directory names end with `/`.
- Lines can wrap.
- The block scrolls when content exceeds the max height.
- Footer left shows entry count, for example `16 项`.
- Footer right shows `成功` or `失败`.

### `search`

Used by:

- `glob`
- `grep`
- `search`
- `rg`
- `find`

Main row:

```text
▸ 运行搜索 · useConversationDisplay
```

Expanded view:

```text
▾ 运行搜索 · useConversationDisplay

   ┌────────────────────────────────────┐
   │ apps/client/src/composables/useConversationDisplay.ts
   │ apps/client/src/components/ProcessGroup.vue
   │                                    │
   │ 2 条                         成功 │
   └────────────────────────────────────┘
   JSON
```

Rules:

- Results are shown in a light console-style block.
- Lines can wrap.
- The block scrolls when content exceeds the max height.
- Footer left shows match count, for example `8 条`.
- Footer right shows `成功` or `失败`.

### `command`

Used by:

- `execute`
- `shell_command`
- `exec_command`
- `bash`
- `npm`

Main row:

```text
▸ 运行命令 · npm --prefix apps/client run build
```

Expanded view:

```text
▾ 运行命令 · npm --prefix apps/client run build

   ✓ built in 422ms
   JSON
```

Rules:

- Show stdout first.
- If stdout is empty, show stderr.
- If both are empty, show `命令无输出`.
- Failed stderr uses the error tone.

### `file-read`

Used by:

- `read_file`
- `cat`
- `sed`

Main row:

```text
▸ 查看文件 · apps/client/src/App.vue
```

Expanded view:

```text
▾ 查看文件 · apps/client/src/App.vue

   import { computed, ref } from 'vue'
   ...
   JSON
```

Rules:

- Show content preview.
- If content is empty, show `读取内容为空`.

### `file-change`

Used by:

- `apply_patch`
- `edit_file`
- `write_file`

Main row:

```text
▸ 变更文件 · apps/client/src/components/ProcessGroup.vue
```

Expanded view:

```text
▾ 变更文件 · apps/client/src/components/ProcessGroup.vue

   已完成
   JSON
```

Rules:

- Show change summary when available.
- Otherwise show `已完成`.
- Future improvement: render a compact diff when diff data is available.

### `browser`

Used by:

- `click`
- `close_page`
- `create_page`
- `evaluate_script`
- `fill`
- `fill_form`
- `handle_dialog`
- `hide_browser`
- `hover`
- `list_pages`
- `navigate_page`
- `press_key`
- `resize_page`
- `select_page`
- `show_browser`
- `take_screenshot`
- `take_snapshot`
- `type_text`
- `upload_file`
- `wait_for`

Main row examples:

```text
▸ 变更页面 · https://www.baidu.com
▸ 查看页面 · 当前网页
```

Expanded view examples:

```text
页面已打开
点击完成
已读取页面结构
```

Rules:

- Prefer page title, URL, or returned result summary when available.
- Otherwise show a short action-specific fallback.

### `generic`

Used by:

- Any tool without a dedicated renderer.

Main row:

```text
▸ 运行工具 · list_skills
```

Expanded view:

```text
已完成
JSON
```

Rules:

- Show a short result preview when available.
- Otherwise show `已完成` or `等待结果`.
- JSON is always available when raw input/output exists.

## JSON Fallback

Every renderer can expose a secondary `JSON` section.

Rules:

- JSON is collapsed by default.
- JSON uses a small disclosure icon.
- JSON contains raw input and raw output.
- JSON should not be the primary visual surface for common tools.

## Current Implementation

Relevant files:

- `apps/client/src/types/conversation.ts`
- `apps/client/src/composables/toolDisplay.ts`
- `apps/client/src/composables/processDisplay.ts`
- `apps/client/src/components/ProcessGroup.vue`
- `apps/client/src/components/ToolStepDetails.vue`
- `apps/client/src/styles/chat.css`
