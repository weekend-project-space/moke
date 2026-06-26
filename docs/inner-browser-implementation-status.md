# Inner Browser Implementation Status

This document summarizes the current implementation status for `docs/inner-browser-mvp.md`.

## Current Architecture

The browser is implemented as a Tauri native webview embedded in the right workspace. AI browser tools are registered through `packages/browser-tools`, executed on the server through `apps/server/browser-bridge.ts`, forwarded to the desktop client through SSE, and finally mapped to Tauri commands by `apps/client/src/api/browserBridge.ts`.

This is not a Playwright/CDP automation stack. Tools that can be implemented with WebView JavaScript evaluation are feasible, but trusted input events, cross-origin iframe access, real screenshots, uploads, and native dialogs have important limitations.

## Implemented

| Tool | Status | Notes |
| --- | --- | --- |
| `navigate_page` | Implemented | Supports URL, back, forward, reload. |
| `list_pages` | Implemented | Lists open browser tabs and active page state. |
| `select_page` | Implemented | Selects a tab by `pageId`. |
| `create_page` | Implemented | Creates a tab, optionally loading a URL. |
| `close_page` | Implemented | Closes a tab by `pageId`. |
| `show_browser` | Implemented | Shows the right browser panel. |
| `hide_browser` | Implemented | Hides the right browser panel. |
| `evaluate_script` | Implemented | Executes a JavaScript function in the active webview. |
| `take_snapshot` | Implemented | Traverses interactive DOM elements and assigns `data-moke-uid` IDs. Supports JSON file output through `filePath`. |
| `take_screenshot` | Implemented | Captures viewport screenshots, element screenshots by snapshot `uid`, and vertical full-page screenshots to PNG files. |
| `click` | Implemented | Clicks or double-clicks a snapshot UID using synthetic events and `element.click()`. |
| `hover` | Implemented | Dispatches synthetic pointer and mouse hover events for a snapshot UID. |
| `fill` | Implemented | Fills input, textarea, select, or contenteditable elements by UID. |
| `fill_form` | Implemented | Batch fill for multiple UID/value pairs. |
| `upload_file` | Implemented | Reads a local file and injects it into a file input by snapshot `uid`. |
| `wait_for` | Implemented | Polls page text until a target string appears. |
| `press_key` | Implemented | Dispatches synthetic keyboard events to the active element. |
| `type_text` | Implemented | Appends text to the active editable element, optionally dispatching a submit key. |
| `handle_dialog` | Implemented | Injects a future dialog policy for `alert`, `confirm`, and `prompt`. |
| `resize_page` | Implemented | Exposes the existing native webview resize command as an AI tool. |

## Implemented With WebView-JS Limitations

| Tool | Feasibility | Reason |
| --- | --- | --- |
| `click` | Medium-high | Uses synthetic pointer/mouse events. Some sites only trust native events. |
| `hover` | Medium | Synthetic hover events may not trigger complex hover behavior in all sites. |
| `fill` / `fill_form` | Medium-high | Works for normal form controls. Framework-specific controls may require extra events. |
| `upload_file` | Medium | Works for direct `input[type=file]` elements or containers containing one. It constructs a browser `File` object instead of setting a real local path. |
| `press_key` / `type_text` | Medium | Synthetic keyboard events are not trusted browser input. |
| `wait_for` | High | Uses page text polling. It does not wait on selectors yet. |
| `handle_dialog` | Medium | Patches future page dialogs after the tool runs. It cannot accept or dismiss an already-open native dialog. |
| `resize_page` | Medium | Resizes the embedded webview bounds, not a full device emulation profile. |
| `take_screenshot` | Medium | Uses native window capture through `xcap`, then crops or stitches browser viewport images. Full-page capture is vertical stitching and may show artifacts on sticky headers, animations, lazy loading, or scroll-snapping pages. |

## Possible But Limited

| Tool | Limitation |
| --- | --- |
| `drag` | Many drag-and-drop libraries require real pointer events or browser internals. |
| `emulate` | User agent and color scheme are best configured before webview creation. Runtime switching is limited. |

## Not Recommended Yet

| Tool | Reason |
| --- | --- |

## Implemented Order

1. `evaluate_script`
2. `take_snapshot`
3. `click`
4. `fill` and `fill_form`
5. `wait_for`
6. `press_key` and `type_text`
7. `resize_page`
8. `hover`
9. `handle_dialog`
10. `take_screenshot` viewport, element, and full-page capture
11. `upload_file`
