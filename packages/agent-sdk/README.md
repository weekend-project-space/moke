# @moke/agent-sdk

Moke Agent Server 的 TypeScript 客户端 SDK。

它将 Session、Run、事件流、问答和工具审批封装为类型化接口，可用于 Node.js、浏览器和 Tauri 客户端。SDK 不包含 Vue 状态、界面组件、Tauri sidecar 管理或 Agent 服务端运行时。

## 当前状态

该包目前是 Moke monorepo 内部 workspace 包，尚未发布到 npm：

```json
{
  "dependencies": {
    "@moke/agent-sdk": "0.1.0"
  }
}
```

运行环境需要提供标准 `fetch`、`ReadableStream`、`AbortController` 和 `TextDecoder`。当前支持的 Node.js 版本已经原生提供这些 API。

## 创建客户端

```ts
import { MokeClient } from '@moke/agent-sdk';

const moke = new MokeClient({
  baseUrl: 'http://127.0.0.1:4010',
  token: runtimeToken,
});
```

配置项：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `baseUrl` | 是 | Moke Server 地址。末尾的 `/` 会被移除。 |
| `token` | 否 | 服务端启用本地访问保护时使用的 bearer token。 |
| `fetch` | 否 | 自定义 fetch，主要用于测试或特殊运行环境。 |
| `defaultTimeoutMs` | 否 | 普通 HTTP 请求超时，默认 30 秒。它不会取消远端 Run。 |
| `userAgent` | 否 | 运行环境允许时附加到请求的 `User-Agent`。 |

## 创建 Session

```ts
const session = await moke.sessions.create({
  title: '代码审查',
  metadata: {
    workspace: 'E:/work/example',
  },
});
```

也可以为已有 Session 创建轻量 handle。该操作不会发起网络请求：

```ts
const session = moke.session('sess_1234');
```

常用 Session 操作：

```ts
const detail = await session.get();
const messages = await session.messages();

await session.rename('新的标题');
await session.pin();
await session.archive();

const forked = await session.fork({
  messageId: 'msg_1234',
});
```

## 发送消息

`send()` 向 Session 写入用户消息并启动一个 Run。它只等待服务器接受请求，不等待 Agent 完成。

```ts
const run = await session.send({
  content: '分析当前项目的架构问题',
  reasoningEffort: 'high',
  limits: {
    max_steps: 100,
    max_tool_calls: 30,
    timeout_ms: 120_000,
  },
});

console.log(run.id);
```

`RunHandle` 可以消费事件、查询结果、回答问题、处理审批或取消远端执行。

## 消费事件流

```ts
for await (const event of run.events()) {
  switch (event.type) {
    case 'agent.message.delta':
      process.stdout.write(event.payload.content);
      break;

    case 'ask_user.required':
      await run.answer({
        requestId: event.payload.ask_id,
        optionId: event.payload.options[0].id,
      });
      break;

    case 'approval.required':
      await run.approve({
        requestId: event.payload.approval_id,
        decision: 'rejected',
        scope: 'once',
      });
      break;
  }
}
```

SDK 会解析 SSE、按事件 `seq` 去重，并通过 `Last-Event-ID` 从最后消费位置恢复。异常断线默认最多重试 8 次；可通过 `maxReconnectAttempts`、`maxReconnectDelayMs` 和 `onReconnect` 调整策略。收到 `agent.done` 或 `agent.error` 后，事件迭代结束。

## 监听应用级 Run 生命周期

`onRunLifecycle()` 用于跨 Session 监听当前 Moke Server 中所有 Run 的状态变化。事件只包含现有 `RunStatus`、Session ID 和 Run ID：

```ts
const off = moke.onRunLifecycle((event) => {
  console.log(event.type, event.sessionId, event.runId);
});

off();
```

也可以让订阅跟随 `AbortSignal` 自动清理：

```ts
const controller = new AbortController();

moke.onRunLifecycle(listener, {
  signal: controller.signal,
  onReconnect() {
    // 清理派生的 Active Run 状态，等待服务端重新同步。
  },
  onError(error) {
    console.error(error);
  },
});

controller.abort();
```

多个 listener 共享同一条生命周期连接。`completed`、`failed`、`cancelled` 和 `timeout` 表示 Run 已终止；单个 Run 的消息、工具和交互细节仍通过 `run.events()` 获取。

## 监听 Session 当前 Run

交互式应用应先使用 `onRunLifecycle()` 维护全局运行状态，再用 `SessionHandle.onRunEvent()` 监听当前 Session 的详细事件：

```ts
const stop = moke.session(sessionId).onRunEvent((event, run) => {
  if (event.type === 'ask_user.required') {
    void run.answer({
      requestId: event.payload.ask_id,
      optionId: event.payload.options[0].id,
    });
  }
});
```

监听建立时可以没有活跃 Run。SDK 会复用全局生命周期连接，自动发现该 Session 当前及后续 Run，并把每个 `AgentEvent` 及其对应的稳定 `RunHandle` 传给 listener。返回的函数只停止本地监听，不取消远端 Run。

可以通过 `AbortSignal` 停止本地等待：

```ts
const controller = new AbortController();

for await (const event of run.events({ signal: controller.signal })) {
  // ...
}
```

取消 signal 不会取消服务器上的 Run。要取消远端执行，必须显式调用：

```ts
await run.cancel();
```

## 等待结果

```ts
const result = await run.result();

console.log(result.status);
console.log(result.message?.content);
console.log(result.usage);
```

如果 Run 仍在执行，`result()` 会等待终止事件；如果 Run 已结束，则直接读取 Run 快照。

恢复已有 Run：

```ts
const run = moke.run('run_1234', 'sess_1234');
const result = await run.result();
```

## 使用 `prompt()`

`prompt()` 是 `send()`、事件消费和结果等待的组合接口。

```ts
const result = await session.prompt({
  content: '总结当前项目',
});
```

如果运行可能触发 `ask_user` 或审批，应显式提供 handlers：

```ts
const result = await session.prompt(
  {
    content: '检查并修改 README',
  },
  {
    handlers: {
      onEvent(event) {
        if (event.type === 'agent.message.delta') {
          process.stdout.write(event.payload.content);
        }
      },

      async onAsk(request) {
        return request.options[0].id;
      },

      async onApproval(request, { run, session }) {
        console.log(`${session.id}/${run.id}: ${request.reason}`);

        return {
          decision: 'approved',
          scope: 'once',
        };
      },
    },
  },
);
```

SDK 会根据当前事件自动补充 ask/approval request ID。审批 handler 只需要返回决策。

## 复用交互处理器

同一套 handlers 需要用于多个 prompt 时，使用 `withHandlers()`：

```ts
const interactiveSession = session.withHandlers({
  onEvent,
  onAsk,
  onApproval,
});

await interactiveSession.prompt({ content: '分析后端' });
await interactiveSession.prompt({ content: '分析前端' });
```

`withHandlers()` 返回新的 `InteractiveSessionHandle`，不会修改原始 Session handle：

```ts
const strictSession = session.withHandlers(strictHandlers);
const permissiveSession = session.withHandlers(permissiveHandlers);

await Promise.all([
  strictSession.prompt({ content: '任务 A' }),
  permissiveSession.prompt({ content: '任务 B' }),
]);
```

单次 prompt 可以覆盖绑定的 handler：

```ts
await interactiveSession.prompt(
  { content: '本次使用更严格的审批策略' },
  {
    handlers: {
      onApproval: strictApprovalHandler,
    },
  },
);
```

传入 `null` 可以显式禁用某个已绑定 handler：

```ts
await interactiveSession.prompt(
  { content: '等待外部代码处理审批' },
  {
    handlers: {
      onApproval: null,
    },
  },
);
```

如果运行需要交互但没有对应 handler，`prompt()` 会抛出 `MokeInteractionRequiredError`。远端 Run 保持等待状态，可稍后通过 `moke.run(error.runId)` 恢复。

`withHandlers()` 只影响 `prompt()`。`send()` 始终只创建 Run，不会隐式消费事件或调用 handlers。

## 图片附件

当前消息接口接受图片上传对象：

```ts
const run = await session.send({
  content: '分析这张截图',
  attachments: [
    {
      id: 'image_1',
      kind: 'image',
      name: 'screen.png',
      mime_type: 'image/png',
      data_url: 'data:image/png;base64,...',
    },
  ],
});
```

具体数量、大小和 MIME 类型限制由 Moke Server 校验。

## 错误处理

```ts
import {
  MokeApiError,
  MokeInteractionRequiredError,
  MokeNetworkError,
  MokeProtocolError,
  MokeRunError,
} from '@moke/agent-sdk';

try {
  await session.prompt({ content: '执行任务' });
} catch (error) {
  if (error instanceof MokeInteractionRequiredError) {
    console.log(error.runId, error.interaction);
  } else if (error instanceof MokeApiError) {
    console.log(error.status, error.code, error.message);
  } else if (error instanceof MokeRunError) {
    console.log(error.runId, error.code);
  } else if (error instanceof MokeNetworkError) {
    console.log('网络或事件流失败');
  } else if (error instanceof MokeProtocolError) {
    console.log('服务端响应不符合 SDK 协议');
  }
}
```

| 错误 | 含义 |
| --- | --- |
| `MokeApiError` | 服务端返回非 2xx HTTP 响应。 |
| `MokeNetworkError` | 请求、超时或事件流连接失败。 |
| `MokeProtocolError` | 服务端 JSON 或事件不符合预期协议。 |
| `MokeRunError` | `prompt()` 等便捷方法等待的 Run 执行失败。 |
| `MokeInteractionRequiredError` | Run 需要问答或审批，但没有对应 handler。 |

## 开发与测试

在仓库根目录执行：

```text
npm run build --workspace @moke/agent-sdk
npm test --workspace @moke/agent-sdk
```

完整回归：

```text
npm test
npm run build
```

更完整的接口契约、HTTP 映射和兼容性约定见 [`../../docs/agent-sdk-interface-design.md`](../../docs/agent-sdk-interface-design.md)。
