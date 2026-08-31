# 代码清理与重构 TODO

## 一、可直接修复或清理

- [x] 修复 `read-only` 权限模式无法运行的问题。
  - `packages/agent-runtime/src/run-manager.ts` 中的 `isPermissionMode()` 需要接受 `read-only`。
  - 补齐并通过 `RunManager` 的只读权限测试。
- [x] 清理未接入当前应用的备用 Run 架构。
  - 删除 `packages/agent-runtime/src/core-runtime.ts` 和 `http-transport.ts`。
  - 删除 `packages/agent-sdk/src/protocol-client.ts`、相关测试及导出。
  - 当前应用统一保留 `RunManager + /api/runs + MokeClient` 调用链。
- [x] 删除未使用的 `RegistryToolProvider` 及其导出。
  - `packages/agent-tools/src/provider.ts`
  - `packages/agent-tools/src/index.ts`
- [x] 删除未被前端调用的 Tauri 命令。
  - 删除 `list_pages`、`create_page`、`navigate_page`、`show_browser`、`hide_browser`、`close_page`。
  - 保留仍在使用的 `select_page` 和 `resize_page`。
- [x] 清理约 200 行无效样式和模板代码。
  - 删除 `apps/client/src/styles/workspace.scss` 中旧 tabs、trace、progress、inspector 和 tool-chip 样式。
  - 删除 `live-turn`、`empty-kicker`、`tool-stage-label`、`tool-stage-json`、`process-tool-meta` 样式。
  - 删除 `ToolResultDetails.vue` 中已注释的旧模板。
- [x] 删除无引用的 `apps/client/src/features/settings/index.ts`。
- [x] 删除 `packages/mcp-client/package.json` 中未使用的 `@moke/protocol` 依赖。
- [x] 将测试中的旧 `RunManagerConfig.workspace` 改为 `defaultWorkspaceRoot`，随后删除兼容回退逻辑。

预计可直接删除约 550-620 行代码，实际删除约 600 行。验证结果为 471 项测试，其中 463 项通过、8 项跳过、0 项失败。

## 二、需要重构或版本决策

- [x] 建立统一的 Tauri 平台桥，集中封装类型化 `invoke`、`listen` 和可用性检查。
- [x] 集中处理设置页面重复的 JSON 请求、响应解析和错误转换逻辑。
- [x] 合并模型、MCP 和消息设置中重复的脏数据检测与放弃修改确认流程，避免引入过度通用的 composable。
  - 新增 `useSettingsDiscardFlow`，仅统一脏状态通知、待执行操作和确认流程。
- [x] 按工作流拆分 `MessagingSettingsPanel.vue`。
  - 连接列表与详情。
  - 微信登录、钉钉与飞书注册、手动凭据配置统一由配置子组件承载展示。
- [x] 将 `ChatWorkspace.vue` 中的工作区与技能发现逻辑提取为独立 composable。
  - 新增 `useWorkspaceDiscovery`，父组件仅负责工作区选择和 Composer 事件转发。
- [x] 按职责拆分 `apps/client/src-tauri/src/lib.rs`。
  - 浏览器状态与命令。
  - 页面捕获。
  - sidecar 生命周期。
  - 工作区打开逻辑。
  - 入口文件仅保留 Tauri Builder、状态注册、命令注册和退出清理。
  - 实现拆分到 `browser.rs`、`capture.rs`、`downloads.rs`、`sidecar.rs`、`workspace.rs` 和 `window.rs`。
- [x] 按持久化职责拆分 `messaging-store.ts`。
  - 连接与密钥。
  - 绑定与入站任务。
  - 发件箱与交互。
  - 数据迁移。
  - 根文件保留 `JsonMessagingStore`、`MessagingStore` 及腐败数据错误的兼容导出。
  - 实现拆分到 `apps/server/storage/messaging/` 下的类型、文件读写、职责 store 和迁移模块。
- [ ] 明确最低可升级版本，再决定是否删除以下兼容逻辑。
  - 会话状态迁移。
  - 消息队列与适配器迁移。
  - 旧 hash 路由。
  - `MOKE_WORKSPACE` 环境变量别名。
  - 无 frontmatter 的 Skill 文件兼容。
  - 旧模型配置标准化。
