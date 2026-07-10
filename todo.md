# 架构改进 TODO

## 安全边界

- [ ] 服务端启动时生成随机访问令牌，所有 HTTP API、SSE 和浏览器桥请求都必须校验令牌。
- [ ] 将 CORS 从通配符改为 Tauri 和本地开发服务器的明确来源白名单。
- [ ] 设置接口不再返回完整 API Key，只返回脱敏值；更新时支持“未修改密钥”的语义。
- [ ] 为浏览器桥增加一次性连接凭据，避免非桌面客户端抢占连接或伪造响应。
- [ ] 恢复 Tauri CSP，并分别限制主窗口和外部网页子 WebView 的能力。

## 存储与生命周期

- [ ] 将会话、运行记录和附件迁移到 SQLite，替代单个 JSON 状态文件。
- [ ] 图片附件保存为独立文件，消息中只保存相对路径、类型、大小和校验信息。
- [ ] 为会话、终态运行和日志增加可配置的保留、归档与清理策略。
- [ ] 服务关闭时主动取消所有运行中的模型请求和工具调用，再关闭 MCP 与 HTTP 服务。

## 客户端拆分

- [ ] 完成 `useAgentSession` 职责拆分：
  - [x] 提取类型化 Session/Run API。
  - [x] 提取 SSE transport 与重连生命周期。
  - [x] 引入判别联合 RunState。
  - [ ] 提取 optimistic message 与流式文本缓冲。
- [ ] 将 `App.vue` 中的消息队列、会话导航和页面布局编排拆成独立 composable。
- [ ] 使用协议包中的判别联合事件类型，移除客户端 `Record<string, any>` 和重复消息类型。
- [ ] 为多会话并行、SSE 重连、乐观消息回滚和排队发送增加组件级集成测试。

## 服务端与运行时

- [ ] 所有路由输入统一使用 Zod schema 校验，并生成一致的错误响应。
- [ ] 将模型历史按完整对话轮次和 token 预算裁剪，而不是固定消息条数。
- [ ] 将 MCP `write`、`dangerous` 工具接入现有审批流程，而不是直接拒绝。
- [ ] 将 Rust `lib.rs` 拆为 sidecar、browser state、browser commands、snapshot 和 script 模块。
- [ ] 为浏览器桥、MCP 生命周期、状态迁移和 Rust 浏览器命令增加故障场景测试。

## 工程结构

- [ ] 改为 npm workspaces，只保留根 lockfile，并通过包名导入 protocol/runtime 等内部包。
- [ ] 为所有内部包补齐 exports、依赖声明和 TypeScript project references。
- [ ] 建立 CI：类型检查、测试、Vue 构建、Rust 检查、依赖审计和生成产物校验。

## 现有功能事项

- [ ] 修复页面工具调用展示问题。
- [ ] 简化工具集合和工具说明。
- [ ] 完成 reface 应用。
- [ ] 完善左侧会话切换体验。
