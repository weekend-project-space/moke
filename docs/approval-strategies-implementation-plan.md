# 审批策略重构实施方案

## 1. 目标

在现有工具审批、Run 暂停、SSE 事件和客户端审批 UI 基础上，完整实现三种审批模式：

| 配置值 | 用户名称 | 审批者 | 行为 |
| --- | --- | --- | --- |
| `manual` | 请求批准 | 用户 | 所有带副作用的工具调用暂停并等待用户决定 |
| `ai_review` | 替我审批 | AI Reviewer | 所有带副作用的工具调用先交给独立 Reviewer；Reviewer 可批准、拒绝或升级给用户 |
| `auto_approve` | 全部自动审批 | 固定规则 | 所有带副作用的工具调用立即批准，不调用模型、不暂停 Run |

本次重构只区分工具是否需要审批，不引入 `safe/write/dangerous` 风险等级。工具通过可信注册信息声明：

```ts
export type ToolApprovalRequirement = 'none' | 'required';

export type RuntimeTool<...> = {
  name: string;
  description: string;
  approval: ToolApprovalRequirement;
  schema: TInput;
  handler: (...args) => Promise<TOutput>;
};
```

模型可以看到工具描述，但不能在 function call 参数里填写或修改 `approval`。审批要求由服务端注册表决定。

## 2. 核心决策

### 2.1 只建立一个审批入口

所有 `approval: 'required'` 的工具都在 `ToolRegistry.execute()` 中进入审批门，工具 handler 不再自行调用 `context.approveTool()`。

```text
模型产生 tool call
  -> ToolRegistry 查找工具
  -> Zod 校验参数
  -> approval === none
       -> 直接执行 handler
  -> approval === required
       -> ApprovalService 根据当前 mode 选择审批者
       -> approved: 执行 handler
       -> rejected: 返回结构化工具错误
       -> escalated: 暂停 Run，等待用户审批
```

这样可以保证审批一定发生在副作用之前，也避免每个 handler 实现不同的审批逻辑。

### 2.2 三种模式只是审批者不同

```ts
export type ApprovalMode = 'manual' | 'ai_review' | 'auto_approve';

export type ApprovalReviewDecision =
  | { decision: 'approved'; reviewer: 'user' | 'ai' | 'auto_approve'; reason?: string }
  | { decision: 'rejected'; reviewer: 'user' | 'ai'; reason: string }
  | { decision: 'escalated'; reviewer: 'ai'; reason: string };
```

- `manual`：直接创建现有 `PendingApproval`，Run 进入 `awaiting_approval`。
- `ai_review`：调用独立 AI Reviewer。`approved` 继续执行，`rejected` 返回工具错误，`escalated` 转入现有用户审批流程。
- `auto_approve`：同步返回批准，`reviewer` 记录为 `auto_approve`。

### 2.3 文件系统路径审批保持独立

现有 `PathRequiresApprovalError`、`approveWorkspacePath()`、目录单次/会话/持久授权继续保留，作为工具审批之外的文件系统边界。

执行顺序为：

```text
工具副作用审批
  -> handler 尝试访问路径
  -> 路径在工作区或已授权目录内：继续
  -> 路径越界：触发现有 workspace_path 审批
```

明确约束：

- `auto_approve` 只自动通过工具副作用审批，不自动授权工作区外目录。
- `read_file` 等无副作用工具访问工作区外文件时，仍会触发路径审批。
- `write_file` 等工具写工作区外文件时，可能先通过工具审批，再触发路径审批；第一版接受两次不同含义的确认。
- schema 校验、`disabled_tools`、消息目标绑定、工具来源限制等硬约束不能通过任何审批模式绕过。

现有实现还有一个独立的已知问题：`LocalSystemBackend` 是全局单例，目录 `once/session` 授权通过修改共享 `approvedRoots` 生效，可能在并发 Run 或不同会话之间短暂共享。三种工具审批模式不能扩大这个问题；完成路径兜底加固时，应让 `once` 按 call、`session` 按 session 隔离，只有 `persistent` 可以作为进程级持久 root 加载。

### 2.4 普通工具审批只使用 `once`

普通工具的用户、AI 和自动审批都只批准当前 tool call，不创建跨调用授权。

- `session`、`persistent` 继续只用于工作区目录授权。
- 不为 shell、浏览器点击、外部消息创建永久工具授权。
- 当前协议可暂时保留 scope 联合类型以兼容 SDK，但普通工具审批统一写入 `scope: 'once'`。

## 3. 目标模块结构

### 3.1 `packages/protocol`

新增或扩展共享类型：

```ts
export type ApprovalMode = 'manual' | 'ai_review' | 'auto_approve';
export type ApprovalReviewer = 'user' | 'ai' | 'auto_approve';

export type SessionEnvironment = {
  approval_mode: ApprovalMode;
  system: {
    platform: 'windows' | 'macos' | 'linux' | 'other';
    arch: string;
    shell: string;
  };
  workspace: {
    root: string;
  };
};

export type Session = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  metadata: Record<string, unknown>;
  env: SessionEnvironment;
};

export type ToolApprovalRecord = {
  approval_id: string;
  kind: 'workspace_path' | 'tool';
  decision: 'approved' | 'rejected';
  scope: 'once' | 'session' | 'persistent';
  reason: string;
  reviewer?: ApprovalReviewer;
  review_reason?: string;
  approval_mode?: ApprovalMode;
};
```

`Session.env` 是服务端管理的可信执行上下文，不是 `process.env`，也不能用任意 `Record<string, unknown>` 表示。严禁在其中保存 API Key、token、完整环境变量、用户名或其他秘密。`reviewer`、`review_reason` 和 `approval_mode` 先做可选字段，保证旧会话 JSON 和旧客户端可以继续读取。

用户审批继续使用现有 `approval.required` 和 `approval.resolved`：

- `manual` 以及 AI 的 `escalated`：发送 `approval.required`，用户决策后发送 `approval.resolved`。
- AI 或 `auto_approve` 直接得出结论：不发送 `approval.required`，避免客户端短暂进入等待状态；决策通过最终 ToolMessage 的 `approvals` 记录展示。
- 第一版不增加 `approval.reviewed` 事件；如果未来需要实时展示 AI 审批过程，再单独增加事件。

### 3.2 `packages/agent-runtime`

新增建议文件：

```text
src/approval-types.ts
src/approval-service.ts
src/approval-reviewer.ts
```

接口建议：

```ts
export type ToolApprovalReviewRequest = {
  approvalId: string;
  runId: string;
  sessionId: string;
  userRequest: string;
  environment: SessionEnvironment;
  origin: RunOrigin;
  tool: string;
  source: { type: 'local' | 'mcp'; server_id?: string };
  input: Record<string, unknown>;
};

export interface AiApprovalReviewer {
  review(
    request: ToolApprovalReviewRequest,
    options: { signal?: AbortSignal },
  ): Promise<
    | { decision: 'approved'; reason: string }
    | { decision: 'rejected'; reason: string }
    | { decision: 'escalated'; reason: string }
  >;
}
```

`ApprovalService` 负责：

1. 根据 Run 从 `session.env.approval_mode` 冻结的模式选择审批者。
2. 为每次审批生成 `approval_id`。
3. 调用 AI Reviewer 或 `auto_approve`。
4. AI 失败时升级为用户审批。
5. 将自动决策写入当前 call 的 approval records。
6. 将用户审批委托给 RunManager 现有 pending 流程。

`ToolRegistry.execute()` 在 Zod 参数校验成功后、handler 执行前调用审批：

```ts
if (tool.approval === 'required') {
  const decision = await context.reviewToolApproval?.({
    tool: tool.name,
    source: tool.source,
    callId: context.currentToolCall?.callId,
    input: normalizedInput,
  });

  if (!decision?.approved) throw createApprovalRejectedError(...);
}
```

不要保留“没有 `reviewToolApproval` 就继续执行”的路径。对于 `approval: 'required'` 的工具，如果审批服务未注入，应抛出 `TOOL_APPROVAL_UNAVAILABLE`。

### 3.3 `RunManager`

Session 是审批配置的来源，Run 创建时冻结审批模式，避免用户在工具执行期间修改 Session 导致同一 Run 的规则变化：

```ts
type RuntimeRun = {
  // existing fields
  approval_mode: ApprovalMode;
};
```

`RunManagerConfig` 增加：

```ts
aiApprovalReviewer?: AiApprovalReviewer;
```

创建 Run 时直接读取：

```ts
run.approval_mode = session.env.approval_mode;
```

RunManager 提供给 ToolContext 的回调改为统一入口：

```ts
reviewToolApproval: (input) =>
  approvalService.reviewTool(run, eventBus, input, {
    userRequest: inputMessage.content,
    signal: abortController.signal,
  });
```

现有 `approveTool()` 拆为两个职责：

- `reviewTool()`：根据模式执行 AI、自动或人工审批。
- `requestUserToolApproval()`：只负责 pending 状态、事件和等待用户响应。

修复现有竞态：必须先把 pending Promise 登记到 `pendingApprovals`，再发布 `approval.required`。用户重复响应继续返回 409，但同一个有效响应只能 resolve 一次、工具只能执行一次。

Run 取消时：

- 中止正在进行的 AI Reviewer 请求。
- 拒绝 pending 用户审批 Promise。
- 不得继续执行工具 handler。

### 3.4 AI Reviewer 实现

模型相关实现放在 `packages/agent-re-act`，runtime 只依赖 `AiApprovalReviewer` 接口。

建议新增：

```text
packages/agent-re-act/src/approval-reviewer.ts
```

Reviewer 使用当前激活的模型供应商配置，但必须是独立、无工具的模型调用：

- 不复用主 Agent 的消息列表。
- 不允许 Reviewer 调用任何工具。
- 温度设为 0。
- 使用较短独立超时，例如 `min(provider.timeoutMs, 30_000)`。
- 输出严格解析为 `approved/rejected/escalated`。
- HTTP、超时、取消以外的异常不得默认批准。

Reviewer 输入只包含：

```text
可信系统审批规则
用户本轮原始请求
工具名称与来源
规范化、脱敏、截断后的工具参数
Run 来源（本地或消息渠道）
Session 中服务端生成的 system 和 workspace 信息
```

不要提供网页正文、工具输出、Skill 内容或任意外部文本，降低提示词注入影响。

参数规范化规则：

- 对 `apiKey/token/password/secret/authorization/cookie` 等字段替换为 `[REDACTED]`。
- 单个字符串最多保留 512 字符。
- 总 JSON 最多保留 8,000 字符。
- `write_file.content`、`edit_file.new_string` 等正文只提供长度和短摘要。
- 保留路径、命令、URL、目标 binding 等判断风险所需字段。

Reviewer 决策规则：

- `approved`：动作与用户请求直接相关，目标明确，影响范围有限。
- `rejected`：动作明显无关、违反硬规则，或表现为恶意/越权尝试。
- `escalated`：删除或不可逆操作、凭据与隐私外发、支付/发布/权限修改、广泛 shell、目标不明确、疑似提示词注入、模型无法确定。

AI Reviewer 返回非法 JSON、空响应、超时或服务错误时统一 `escalated`，随后进入用户审批；只有 Run 已取消时直接取消，不再升级。

### 3.5 Session Environment

审批模式保存在每个 Session 中，不写入全局 `.moke/settings.json`。`metadata` 继续承载标题编辑、归档、消息渠道等业务扩展；`env` 只承载服务端认可的执行环境和策略。

Session 创建时由服务端构造完整环境：

```ts
function createSessionEnvironment(input: {
  approvalMode?: ApprovalMode;
  workspace: string;
}): SessionEnvironment {
  return {
    approval_mode: normalizeApprovalMode(input.approvalMode),
    system: {
      platform: normalizePlatform(process.platform),
      arch: process.arch,
      shell: resolveCurrentShell(),
    },
    workspace: {
      root: input.workspace,
    },
  };
}
```

约束：

- 新建普通 Session 默认 `manual`。
- 外部消息渠道自动创建的 Session 默认 `manual`。
- fork Session 继承源 Session 的 `approval_mode`，并深拷贝 `env`。
- `system` 和 `workspace` 是只读快照，只能由服务端创建或迁移代码填写。
- 客户端请求中的 `env.system`、`env.workspace` 一律拒绝或忽略，不能覆盖服务端事实。
- `metadata.workspace` 不是可信执行路径；旧 Session 迁移时使用当前服务端 workspace，不从 metadata 提升权限。
- 审批模式更新后立即持久化 Session 并更新 `updated_at`。
- 已运行的 Run 保持自己的 `approval_mode`；新 Run 读取最新 Session 值。
- Run 启动时可将 `env.system` 和 `env.workspace` 注入主 Agent 的 trusted system context；不要把它们保存成伪造的 user message。

旧会话迁移：

- Session JSON 没有 `env` 时，加载阶段用当前服务端环境补齐，并将 `approval_mode` 设为 `manual`。
- `env` 缺字段或值非法时逐字段归一化，不能因为新增字段拒绝整个旧会话。
- Session store 的 index summary 需要随 Session 保存 `env`，或者至少保存 `env.approval_mode`；推荐保留完整的小型 `env`，避免列表和详情类型不一致。
- 提升 Session index version 并从 Session 文件重建 index，不能继续接受缺少 env 的旧 summary 缓存。
- 第一次补齐后正常写回 Session 文件，不单独建立迁移脚本。

增加 Session API：

```text
POST /api/sessions
body {
  "title": "New chat",
  "env": { "approval_mode": "manual" }
}

PATCH /api/sessions/:id/env
body { "approval_mode": "manual" | "ai_review" | "auto_approve" }

GET /api/sessions
GET /api/sessions/:id
```

`POST` 只接受可选 `env.approval_mode`，其他 env 字段由服务端生成。`PATCH` 只允许更新 `approval_mode`，返回更新后的 SessionSummary。不要提供任意 env merge API。

建议将 `apps/server/routes/sessions.ts` 中重复的 Session 构造收口到 `SessionApplicationService.createSession()`，确保本地 API 和消息渠道创建的 Session 都经过同一个 environment builder。

### 3.6 客户端 Session UI

审批模式属于当前 Session，三段式选择控件放在聊天页 Header 的权限菜单中，而不是全局 Settings Permissions 页面：

```text
请求批准 | 替我审批 | 全部自动审批
```

行为要求：

- 选择当前 Session 时，从 SessionSummary 或 Session 详情读取 `env.approval_mode`。
- 用户切换后调用 `PATCH /api/sessions/:id/env`。
- 保存失败时恢复原选项并显示错误。
- 模式修改只影响之后创建的 Run；当前 Run 保持创建时模式。
- 新建 Session 使用 `manual`，不自动继承上一个聊天的模式。
- fork Session 在 UI 中显示继承后的模式。
- Settings Permissions 页面继续只展示和撤销持久目录授权。

不要允许模型、聊天文本或工具调用修改 Session env。

## 4. 工具审批分类

第一版使用静态 `approval`，不实现动态 resolver。只要一个工具的任意合法调用可能产生有意义的副作用，就保守标记为 `required`。

### 4.1 本地与 Skill 工具

| 工具 | approval | 原因 |
| --- | --- | --- |
| `activate_skill` | `none` | 只修改当前 Agent 上下文，不产生外部副作用 |
| `ls` | `none` | 读取 |
| `glob` | `none` | 读取 |
| `grep` | `none` | 读取 |
| `search` | `none` | 读取 |
| `read_file` | `none` | 读取；工作区外由路径审批兜底 |
| `write_file` | `required` | 写文件 |
| `edit_file` | `required` | 修改文件 |
| `execute` | `required` | 任意进程或 shell 副作用 |

`execute` handler 中现有“复杂命令才审批”的逻辑删除，命令工具统一在 ToolRegistry 层审批。现有命令路径越界检查继续保留。

### 4.2 浏览器工具

| 工具 | approval | 原因 |
| --- | --- | --- |
| `list_pages` | `none` | 读取浏览器状态 |
| `select_page` | `none` | 仅切换本地 UI |
| `take_snapshot` | `required` | 可通过 `filePath` 写文件，静态分类从严 |
| `take_screenshot` | `required` | 可通过 `path` 写文件，静态分类从严 |
| `hover` | `none` | 通常不提交状态 |
| `wait_for` | `none` | 只等待和读取 |
| `resize_page` | `none` | 仅改变本地视口 |
| `show_browser` | `none` | 仅改变本地 UI |
| `hide_browser` | `none` | 仅改变本地 UI |
| `create_page` | `required` | 可能访问网络 |
| `close_page` | `required` | 丢弃页面状态 |
| `navigate_page` | `required` | 网络访问和页面状态变化 |
| `evaluate_script` | `required` | 任意页面脚本 |
| `click` | `required` | 可能提交外部操作 |
| `fill` | `required` | 修改页面输入状态 |
| `fill_form` | `required` | 修改页面输入状态 |
| `upload_file` | `required` | 文件外发 |
| `press_key` | `required` | 可能提交外部操作 |
| `type_text` | `required` | 可能输入并提交内容 |
| `handle_dialog` | `required` | 接受或拒绝页面操作 |

后续若审批频率过高，可以把 `take_snapshot/take_screenshot/create_page` 拆分成无副作用和有副作用的独立工具；本次不增加动态分类。

### 4.3 消息工具

| 工具 | approval | 原因 |
| --- | --- | --- |
| `send_message` | `required` | 对外发送文本、图片或文件 |

删除当前仅在包含媒体时调用 `approveTool()` 的逻辑。文本和媒体都由统一审批门处理；媒体路径检查和 Outbox 幂等继续保留。

### 4.4 MCP 工具

MCP 工具默认：

```ts
approval: 'required'
```

原因是第三方 MCP annotations 只是提示，不能直接作为可信授权依据。为了支持明确的只读 MCP 工具，在单个 server 配置中增加可选列表：

```json
{
  "id": "filesystem",
  "read_only_tools": ["read_file", "list_directory"]
}
```

注册时只有列入 `read_only_tools` 的原始工具名使用 `approval: 'none'`，其余均为 `required`。`disabled_tools` 优先级更高，禁用工具不注册。

不要让模型通过 MCP tool input 提交 `approval` 或安全等级。

## 5. 审批记录与客户端展示

当前 tool call 的审批结果继续附加到最终 ToolMessage：

```json
{
  "approval_id": "apv_123",
  "kind": "tool",
  "decision": "approved",
  "scope": "once",
  "reason": "Tool has declared side effects",
  "reviewer": "ai",
  "review_reason": "The requested edit is limited to the active workspace and matches the user request"
}
```

展示建议：

- 用户批准：`Allowed once`。
- AI 批准：`Approved by AI`。
- 自动批准：`Automatically approved`。
- AI 拒绝：`Rejected by AI`，工具结果为 error。
- AI 升级后用户决定：最终记录 reviewer 为 `user`，`review_reason` 保留 AI 升级原因。

审批参数可能包含文件正文、消息内容和凭据，事件与持久记录不得复制完整 input。`PendingApproval.action.input` 的现有完整输入暴露问题应在本次改为安全预览：路径、命令、URL、目标和截断摘要；实际 handler 仍使用内存中的已校验原始参数。

## 6. 错误语义

统一错误码：

| code | 场景 |
| --- | --- |
| `TOOL_APPROVAL_UNAVAILABLE` | required 工具没有审批服务 |
| `TOOL_APPROVAL_REJECTED` | 用户或 AI 拒绝 |
| `AI_APPROVAL_REVIEW_FAILED` | 仅用于内部日志；对 Run 行为应升级用户审批 |
| `APPROVAL_NOT_PENDING` | 过期或重复用户响应 |

拒绝是工具执行错误，不应让整个 Run 直接失败。ReAct 循环应像处理其他 ToolExecutionError 一样把拒绝结果返回模型，让模型选择替代方案或向用户说明。

## 7. 测试矩阵

至少覆盖以下矩阵：

| approval | mode | 预期 |
| --- | --- | --- |
| `none` | 任意 | 不调用 reviewer，直接执行 |
| `required` | `manual` | 发 required 事件，等待用户，批准后执行 |
| `required` | `manual` | 用户拒绝，handler 不执行 |
| `required` | `ai_review` | AI 批准，handler 执行，不产生 pending UI |
| `required` | `ai_review` | AI 拒绝，handler 不执行，产生工具错误记录 |
| `required` | `ai_review` | AI 升级，转为用户 pending |
| `required` | `ai_review` | AI 超时/非法输出，转为用户 pending |
| `required` | `auto_approve` | 不调用模型、不暂停，handler 执行并记录自动批准 |

额外场景：

- Run 在 AI 审批期间取消，handler 永不执行。
- Run 在用户审批期间取消，pending Promise 被拒绝。
- 同一审批重复响应，handler 最多执行一次。
- `approval.required` 发布后立即响应不会得到错误竞态。
- `auto_approve + read_file(工作区外)` 仍触发 workspace_path 用户审批。
- `auto_approve + write_file(工作区外)` 自动通过工具审批，但仍触发 workspace_path 用户审批。
- MCP 未配置 `read_only_tools` 时全部 required。
- MCP read-only 列表只按 server 内原始工具名生效。
- 没有 `env` 的旧 Session 可以补齐、保存并正常加载。
- fork Session 继承审批模式，系统环境字段保持深拷贝。
- 外部消息渠道创建的 Session 默认使用 manual。
- Session env API 不能修改 `system` 或 `workspace`。
- 切换 Session 模式不影响已经运行的 Run。
- AI Reviewer 输入完成敏感字段脱敏和长度限制。
- `send_message` 发送纯文本也必须经过统一审批。

## 8. 分阶段 TODO

### Phase 1：协议与工具声明

- [x] 在 protocol 中增加 `ApprovalMode`、`ApprovalReviewer` 类型。
- [x] 给 `ToolApprovalRecord` 增加可选 `reviewer`、`review_reason`。
- [x] 在 agent-runtime 中增加 `ToolApprovalRequirement = 'none' | 'required'`。
- [x] 将 `RuntimeTool.approval` 设为必填，确保新增工具漏声明时 TypeScript 编译失败。
- [x] 按第 4 节给所有本地、Skill、浏览器和消息工具补齐声明。
- [x] 给所有测试 fixture 中的 RuntimeTool 补齐声明。
- [x] 更新 `/api/tools` 响应，使其包含只读 `approval` 元数据。
- [x] 更新 agent API 文档中已经过期的工具审批/MCP 描述。

### Phase 2：统一审批门

- [x] 在 ToolRegistry 参数校验后、handler 前调用统一审批入口。
- [x] required 工具缺少审批入口时 fail closed。
- [x] 将审批拒绝统一转换为 `TOOL_APPROVAL_REJECTED`。
- [x] 从 `execute` handler 删除复杂命令的局部审批调用。
- [x] 从 `send_message` handler 删除媒体专用审批调用。
- [x] 全仓搜索 `approveTool`，移除其他 handler 内的重复审批。
- [x] 保留并验证 `PathRequiresApprovalError` 的 handler 重试流程。
- [x] 增加 ToolRegistry 的批准、拒绝、未注入审批器和路径重试单元测试；三种 Session 模式测试随 Phase 3 实现。

### Phase 3：ApprovalService 与人工审批

- [x] 新建 reviewer 接口，并将 ApprovalService 的决策职责收口到 RunManager 的 `reviewTool()`。
- [x] Run 创建时从 `session.env.approval_mode` 读取并冻结模式。
- [x] 将 RunManager 的工具审批拆成 review 和 request-user 两层。
- [x] 将自动审批记录写入当前 call 的 approvalRecords。
- [x] 修复 pending 先发事件、后登记 Promise 的竞态。
- [x] 保证响应幂等和 handler exactly-once。
- [x] Run 取消时正确中止 reviewer 和 pending 用户审批。
- [x] 普通工具审批强制使用 scope once。
- [x] 保持 workspace_path 的 once/session/persistent 行为。

### Phase 4：AI Reviewer

- [x] 在 agent-re-act 新增无工具 AI Reviewer。
- [x] 同时支持现有 openai-compatible 和 openai-responses provider 类型。
- [x] 定义固定系统规则和严格结构化输出 schema。
- [x] 实现参数脱敏、字符串截断和总长度限制。
- [x] 实现 `approved/rejected/escalated` 三态解析。
- [x] Reviewer 超时、网络错误、非法输出时升级用户审批。
- [x] Reviewer 遵循 Run AbortSignal。
- [x] 增加 Reviewer 结构化 approve/reject 测试，以及 Run 的 AI reject/escalate/cancel 审批流测试。
- [x] 确认 Reviewer 不接收工具输出、网页正文或 Skill 内容。

### Phase 5：Session Environment、API 与 UI

- [x] 在 protocol 中增加强类型 `SessionEnvironment` 和 `Session.env`（旧持久化数据兼容为可选，加载后补齐）。
- [x] 实现 `normalizeApprovalMode()` 和服务端 `createSessionEnvironment()`。
- [x] 将 routes 和消息渠道的 Session 创建统一收口到 SessionApplicationService。
- [x] 新建 Session 和消息渠道 Session 默认使用 manual。
- [x] fork Session 深拷贝 env 并继承 approval_mode。
- [x] SessionStore 加载旧 Session 时补齐 env，更新 Session 与 index 校验。
- [x] 提升 Session index version，从 Session 文件重建带 env 的 summaries。
- [x] 扩展 createSessionSchema，只允许客户端提供可选 `env.approval_mode`。
- [x] 增加 `PATCH /api/sessions/:id/env` 严格 Zod schema 和路由测试。
- [x] 确保 env API 不能覆盖 system、workspace 或注入其他字段。
- [x] 在 server factory 注入 AI Reviewer，审批模式直接从 Session 获取。
- [x] 在 ChatHeader 权限菜单增加 Session 级三段式模式控件。
- [x] 实现 Session 模式加载、保存和失败时保留原模式。
- [x] 将 env.system/workspace 作为 trusted system context 提供给主 Agent 和 AI Reviewer。
- [x] 更新 agent-sdk 的 create/update Session 类型和便捷方法。
- [x] 增加旧 Session 迁移、fork、消息渠道默认值和客户端交互测试。

### Phase 6：MCP 与审计展示

- [x] MCP server schema 增加 `read_only_tools`，默认空数组。
- [x] McpTool 保留原始工具名并据配置生成 approval 声明。
- [x] 增加 MCP 默认 required、显式 read-only、disabled 优先级测试。
- [x] 更新 MCP 示例和 README。
- [x] ToolMessage 展示 reviewer 和 review_reason。
- [x] PendingApproval 只发送安全参数预览，不发送敏感完整 input。
- [x] 更新桌面客户端、消息渠道和 Agent SDK 的兼容测试。

### Phase 7：集成验收

- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm test`。
- [x] 运行 `npm run build`。
- [ ] 手工验证 manual：写文件前等待用户，拒绝后文件不变化。
- [ ] 手工验证 ai_review：普通编辑自动批准，高风险动作升级或拒绝。
- [ ] 手工验证 auto_approve：副作用工具不中断执行，记录仍可见。
- [ ] 手工验证三种模式下工作区外路径仍出现目录授权提示。
- [ ] 手工验证 SSE 重连后 pending 人工审批可以恢复。
- [ ] 手工验证消息渠道的人工升级审批可以完成并恢复 Run。
- [ ] 加固目录授权隔离：once 不跨 call，session 不跨会话，并增加并发 Run 回归测试。

## 9. 完成标准

同时满足以下条件才算完成：

1. 每个 RuntimeTool 必须显式声明 `approval`，漏声明无法通过类型检查。
2. 所有 required 工具在 handler 前经过唯一的 ApprovalService。
3. 三种模式行为与第 1 节表格一致。
4. AI Reviewer 不能直接绕过硬约束，失败时不会默认批准。
5. `auto_approve` 不绕过工作区外路径授权。
6. 用户拒绝、AI 拒绝、Run 取消时均不会执行 handler。
7. 自动和 AI 审批均留下可持久化、可展示的审计记录。
8. 旧会话自动补齐 env，现有 SDK 事件消费保持兼容。
9. 类型检查、测试和客户端构建全部通过。

## 10. 非目标

本次不实现：

- `safe/write/dangerous` 多级风险体系。
- 根据工具参数动态切换 `none/required`。
- 让主 Agent 模型在 tool input 中自报风险或审批要求。
- 普通工具的 session/persistent 永久放行规则。
- AI Reviewer 自动授予工作区外目录权限。
- 全局审批模式或从上一个 Session 自动继承模式。
- 企业级用户身份、角色和多审批人流程。
- 独立审批模型配置 UI；第一版复用当前激活模型供应商。
