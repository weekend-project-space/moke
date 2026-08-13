# @moke/agent-sdk

Moke Agent Server 的 TypeScript 客户端 SDK，提供 Session、Run、SSE 事件流和交互处理接口。

## 创建客户端

```ts
import { MokeClient } from '@moke/agent-sdk';

const client = new MokeClient({
  baseUrl: 'http://127.0.0.1:4010',
  token: process.env.MOKE_TOKEN,
});
```

## 创建 Run

```ts
const session = client.session('sess_123');
const run = await session.send({ content: '分析当前项目' });
```

`send()` 只负责创建远程 Run。使用 `run.events()` 消费实时事件，或使用 `session.chat()` 完成创建、消费和等待结果的一体化流程。

## AgentEvent

事件类型来自 `@moke/agent-protocol`，所有事件共享以下字段：

```ts
type EventBase = {
  eventId: string;
  sequence: number;
  threadId: string;
  runId: string;
  timestamp: number; // Unix epoch milliseconds
  type: string;
};
```

常用事件：

- `run.started`, `run.completed`, `run.failed`, `run.timed_out`, `run.cancelled`
- `message.started`, `message.content`, `message.completed`
- `reasoning_message.content`, `reasoning_message.completed`
- `tool_call.started`, `tool_call.args`, `tool_call.completed`
- `tool_result.completed`, `tool_result.failed`
- `interaction.required`, `interaction.resolved`

事件数据直接位于事件对象上，不再使用旧的 `payload`、`seq`、`ts`、`session_id` 或 `run_id` 字段。

```ts
for await (const event of run.events()) {
  switch (event.type) {
    case 'message.content':
      process.stdout.write(event.delta);
      break;
    case 'tool_call.started':
      console.log('tool:', event.toolCallName, event.toolCallId);
      break;
    case 'run.completed':
      console.log('completed');
      break;
    case 'run.failed':
    case 'run.timed_out':
      console.error(event.error.code, event.error.message);
      break;
  }
}
```

SDK 会根据 `sequence` 去重，并通过 `Last-Event-ID` 从断点继续消费。可通过 `afterSeq`、`maxReconnectAttempts`、`maxReconnectDelayMs` 和 `onReconnect` 调整重连行为。

## 交互处理

`interaction.required` 的 `interaction.type` 为 `question` 或 `approval`。可以手动处理：

```ts
for await (const event of run.events()) {
  if (event.type !== 'interaction.required') continue;

  if (event.interaction.type === 'question') {
    await run.answer({ requestId: event.interaction.id, optionId: event.interaction.options?.[0]?.id });
  } else {
    await run.approve({ requestId: event.interaction.id, decision: 'approved', scope: 'once' });
  }
}
```

也可以使用 `chat()` 自动消费事件：

```ts
const result = await session.chat(
  { content: '检查并修改 README' },
  {
    handlers: {
      onEvent(event) {
        if (event.type === 'message.content') process.stdout.write(event.delta);
      },
      async onAsk(request) {
        return request.options[0]?.id ?? '';
      },
      async onApproval() {
        return { decision: 'approved', scope: 'once' };
      },
    },
  },
);
```

如果 Run 需要交互但没有对应 handler，`chat()` 会抛出 `MokeInteractionRequiredError`，Run 会保持等待状态，可稍后使用 `run.answer()` 或 `run.approve()` 恢复。

## 获取结果和取消

```ts
const result = await run.result();
console.log(result.status, result.message?.content, result.usage);

await run.cancel();
```

结果状态为 `completed`、`failed`、`cancelled` 或 `timeout`。

## 错误类型

- `MokeApiError`: 服务端返回非 2xx
- `MokeNetworkError`: 网络、超时或 SSE 连接失败
- `MokeProtocolError`: 响应不符合协议
- `MokeRunError`: Run 执行失败
- `MokeInteractionRequiredError`: 缺少交互 handler

## 开发与测试

```bash
npm run build --workspace @moke/agent-sdk
npm test --workspace @moke/agent-sdk
```
