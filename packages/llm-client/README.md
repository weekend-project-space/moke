# @moke/llm-client

`@moke/llm-client` 是一个轻量、事件驱动的 TypeScript LLM 客户端。它统一 OpenAI Responses、OpenAI Chat Completions 和第三方 OpenAI-compatible 接口，让上层代码使用同一套请求、流事件和最终响应模型。

该模块只负责模型调用，不负责 Agent 循环、工具执行、会话持久化或 UI 状态。

## 功能

- 支持 OpenAI Responses API。
- 支持 OpenAI Chat Completions API。
- 支持可配置的第三方 OpenAI-compatible Chat Completions 服务。
- 支持正文、思考摘要、工具调用和 token usage 流事件。
- 同时提供回调 Handler、异步事件迭代和最终结果 Promise。
- 支持取消、超时、请求前安全重试和结构化错误。
- 保留未知 Provider 原始事件，方便兼容新协议能力。
- 不依赖 OpenAI SDK，使用标准 `fetch`、SSE 和 Web Streams。

## Provider

| Provider | 接口 | 适用场景 |
| --- | --- | --- |
| `openai-responses` | `/v1/responses` | 新的 OpenAI 集成，默认推荐 |
| `openai-chat-completions` | `/v1/chat/completions` | 已有 OpenAI Chat Completions 应用 |
| `openai-compatible` | 默认 `/chat/completions` | llama.cpp 等第三方兼容服务 |

Provider 必须显式选择。客户端不会在 Responses 请求失败后自动降级到 Chat Completions。

## 使用条件

- Node.js 需要提供标准 `fetch` 和 Web Streams，建议使用 Node.js 20 或更高版本。
- 浏览器环境必须避免在前端代码中暴露 OpenAI API Key。生产环境通常应通过自己的服务端调用此模块。

仓库内可直接引用 workspace 包：

```ts
import { createLlmClient } from '@moke/llm-client';
```

构建和测试：

```bash
npm run build --workspace @moke/llm-client
npm test --workspace @moke/llm-client
```

## 快速开始

### OpenAI Responses

```ts
import { createLlmClient } from '@moke/llm-client';

const client = createLlmClient({
  provider: 'openai-responses',
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6',
  timeoutMs: 120_000,
});

const run = client.chat(
  {
    instructions: '你是一个简洁、准确的技术助手。',
    input: '解释什么是事件驱动架构。',
  },
  {
    onTextDelta(delta) {
      process.stdout.write(delta.text);
    },
    onCompleted(response) {
      console.log('\nusage:', response.usage);
    },
    onFailed(error) {
      console.error(error);
    },
  },
);

const response = await run.result();
```

`chat()` 是推荐的主要入口。它返回 `ChatRun`，可以监听生成过程、读取中间状态、消费事件、取消请求，并通过 `run.result()` 获取最终响应。

只关心最终结果时，可以使用 `complete()`：

```ts
const response = await client.complete('解释什么是事件驱动架构。');
console.log(response.text);
```

两者的请求能力和最终 `ChatResponse` 一致。可以简单理解为：

```text
complete = chat + 自动等待 result
```

### OpenAI Chat Completions

```ts
const client = createLlmClient({
  provider: 'openai-chat-completions',
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
});

const run = client.chat({
  instructions: 'You are a helpful assistant.',
  input: 'Tell me a short joke.',
});

const response = await run.result();
console.log(response.text);
```

业务层调用方式与 Responses 相同，客户端会负责 `messages`、流式 chunk、`[DONE]` 和 usage 的协议转换。

## 流式回调

`chat()` 会立即返回一个 `ChatRun`。Handler 注册完成后，网络请求才会在微任务中启动，因此不会漏掉首个事件。

```ts
const run = client.chat(
  {
    input: '写一个 TypeScript 防抖函数。',
  },
  {
    onStarted(event, context) {
      console.log('response:', event.responseId);
      console.log('run:', context.runId);
    },

    onTextDelta(delta) {
      process.stdout.write(delta.text);
    },

    onThinkingDelta(delta) {
      console.debug('thinking:', delta.text);
    },

    onToolCallDelta(delta) {
      console.debug('tool arguments delta:', delta.argumentsDelta);
    },

    onToolCallCompleted(toolCall) {
      console.log('tool call:', toolCall.name, toolCall.arguments);
    },

    onUsageUpdated(usage) {
      console.log('tokens:', usage.totalTokens);
    },

    onUnmappedRawEvent(event) {
      console.debug('unmapped provider event:', event.type);
    },

    onCompleted(response) {
      console.log('\ncompleted:', response.finishReason);
    },

    onFailed(error) {
      console.error(error.kind, error.message);
    },

    onCancelled(cancellation) {
      console.log('cancelled:', cancellation.reason);
    },
  },
);

const response = await run.result();
```

`onCompleted` 和 `onFailed` 是 Handler 的必需方法，其余回调均可选。`onCompleted`、`onFailed` 和 `onCancelled` 三种终态互斥。

Handler 抛出的异常不会中断模型流。可以通过客户端诊断钩子收集这类错误：

```ts
const client = createLlmClient({
  provider: 'openai-responses',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-5.6',
  diagnostics: {
    onHandlerError(error, event) {
      console.error('handler failed at', event.type, error);
    },
  },
});
```

## 异步事件迭代

需要统一处理事件或保留背压时，可以直接消费 `LlmStreamEvent`：

```ts
const run = client.chat('介绍一下 SSE。');

for await (const event of run.events()) {
  switch (event.type) {
    case 'text.delta':
      process.stdout.write(event.payload.delta);
      break;

    case 'tool_call.completed':
      console.log('tool:', event.payload);
      break;

    case 'run.failed':
      console.error(event.payload);
      break;
  }
}

const response = await run.result();
```

当前每个 `ChatRun` 只允许创建一个事件迭代器。Handler 和该迭代器可以同时使用，并观察相同的事件顺序。

常见事件：

```text
run.started
text.delta
text.completed
thinking.delta
thinking.completed
tool_call.delta
tool_call.completed
usage.updated
provider.raw
run.completed
run.failed
run.cancelled
```

每个事件都包含 `runId`、`sequence`、`timestamp` 和 Provider 元数据。`sequence` 在单个 Run 内严格递增。

## 消息和多轮对话

简单请求可以直接向 `chat()` 传字符串：

```ts
const run = client.chat('Hello');
const response = await run.result();
```

需要完整历史时传入消息项：

```ts
const run = client.chat({
  input: [
    {
      type: 'message',
      role: 'developer',
      content: 'You are a helpful assistant.',
    },
    {
      type: 'message',
      role: 'user',
      content: 'What is the capital of France?',
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'Paris.',
    },
    {
      type: 'message',
      role: 'user',
      content: 'And its population?',
    },
  ],
});

const response = await run.result();
```

Responses API 也可以通过 `previousResponseId` 连接上一轮：

```ts
const first = await client.chat({
  instructions: '回答要简洁。',
  input: '法国首都是哪里？',
}).result();

const second = await client.chat({
  instructions: '回答要简洁。',
  previousResponseId: first.id,
  input: '那里有多少人口？',
}).result();
```

使用 `previousResponseId` 时，每轮仍应重新发送需要持续生效的 `instructions`。Chat Completions 不支持 `previousResponseId`，必须由调用方提交完整消息历史。

## 工具调用

客户端负责声明工具并返回结构化工具调用，但不会自动执行工具。

```ts
const run = client.chat({
  input: '上海现在天气怎么样？',
  tools: [
    {
      type: 'function',
      name: 'get_weather',
      description: '查询指定城市的天气',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
        additionalProperties: false,
      },
    },
  ],
  toolChoice: 'auto',
});

const response = await run.result();

for (const toolCall of response.toolCalls) {
  console.log(toolCall.callId);
  console.log(toolCall.name);
  console.log(toolCall.arguments);
}
```

执行工具后，将结果作为下一次输入发送。Responses 示例：

```ts
const toolCall = response.toolCalls[0];
const toolOutput = await getWeather(toolCall.arguments);

const finalResponse = await client.chat({
  previousResponseId: response.id,
  input: [
    {
      type: 'tool_result',
      callId: toolCall.callId,
      output: toolOutput,
    },
  ],
}).result();
```

Chat Completions 需要把 assistant 工具调用和工具结果一同加入历史：

```ts
const finalResponse = await client.chat({
  input: [
    { type: 'message', role: 'user', content: '上海现在天气怎么样？' },
    {
      type: 'tool_call',
      callId: toolCall.callId,
      name: toolCall.name,
      arguments: toolCall.argumentsJson,
    },
    {
      type: 'tool_result',
      callId: toolCall.callId,
      output: toolOutput,
    },
  ],
}).result();
```

只有完整的 `tool_call.completed` 或 `response.toolCalls` 可以进入工具执行流程。参数增量可能不是合法 JSON，不应提前执行。

## 取消和超时

通过 `ChatRun.cancel()` 取消：

```ts
const run = client.chat('生成一篇长文章。', {
  onCompleted(response) {
    console.log(response.text);
  },
  onFailed(error) {
    console.error(error);
  },
});

setTimeout(() => {
  run.cancel('用户停止生成');
}, 1_000);

try {
  await run.result();
} catch (error) {
  if (error instanceof LlmClientError && error.kind === 'cancelled') {
    console.log('请求已取消');
  }
}
```

也可以使用 `AbortSignal`：

```ts
const controller = new AbortController();

const run = client.chat({
  input: '生成一篇长文章。',
  signal: controller.signal,
  timeoutMs: 30_000,
});

controller.abort('页面已关闭');
```

用户取消和超时语义不同：取消产生 `cancelled` 错误，超时产生 `timeout` 错误。

## 错误处理

所有模型、网络和协议错误都会转换为 `LlmClientError`：

```ts
import { LlmClientError } from '@moke/llm-client';

try {
  await client.chat('Hello').result();
} catch (error) {
  if (!(error instanceof LlmClientError)) throw error;

  console.error(error.kind);
  console.error(error.statusCode);
  console.error(error.providerRequestId);

  if (error.retryable) {
    console.log('该错误在业务条件允许时可以重试');
  }
}
```

错误类型包括：

```text
authentication
authorization
rate_limit
invalid_request
unsupported_feature
transport
timeout
provider
protocol
cancelled
```

客户端只会在 Provider 尚未开始返回有效流事件时自动重试。已经产生正文或工具调用后不会自动重放整个请求，以免重复输出或重复副作用。

## OpenAI-compatible 服务

第三方服务应使用 `openai-compatible`，并显式声明协议差异：

```ts
const client = createLlmClient({
  provider: 'openai-compatible',
  apiKey: process.env.LOCAL_LLM_API_KEY || 'local',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'local-model',
  compatible: {
    supportsDeveloperRole: false,
    supportsStreamUsage: false,
    supportsParallelToolCalls: false,
    reasoningFormat: 'reasoning_content',
  },
});
```

可用兼容配置：

| 配置 | 作用 |
| --- | --- |
| `endpoint` | 覆盖默认 `/chat/completions` 路径 |
| `supportsDeveloperRole` | 不支持时将 `developer` 转为 `system` |
| `supportsStreamUsage` | 是否发送 `stream_options.include_usage` |
| `supportsParallelToolCalls` | 是否发送 `parallel_tool_calls` |
| `reasoningFormat: 'reasoning_content'` | 将 `delta.reasoning_content` 转换为思考事件 |

兼容服务的能力差异较大。配置只控制已知协议差异，不保证任意 OpenAI 风格端点都完全兼容。

## 请求配置

常用 `ChatRequest` 字段：

```ts
const response = await client.chat({
  input: '给出三个标题。',
  model: 'gpt-5.6',
  instructions: '只输出标题。',
  reasoning: { effort: 'medium' },
  maxOutputTokens: 300,
  temperature: 0.4,
  topP: 0.9,
  parallelToolCalls: true,
  store: false,
  metadata: {
    feature: 'title-generator',
  },
  providerOptions: {
    service_tier: 'default',
  },
}).result();
```

`providerOptions` 会进入 Provider 请求体，用于尚未进入统一接口的原生参数。它不具备跨 Provider 可移植性，且同名统一字段会覆盖其中的值。

## 返回结果

简单文本读取 `response.text`：

```ts
console.log(response.text);
```

复杂响应应读取 `response.output`：

```ts
for (const item of response.output) {
  switch (item.type) {
    case 'text':
      console.log(item.text);
      break;
    case 'tool_call':
      console.log(item.toolCall);
      break;
    case 'refusal':
      console.warn(item.text);
      break;
  }
}
```

`ChatResponse` 还包含：

- `id`：Provider 响应 ID。
- `runId`：本地 `ChatRun` ID。
- `provider` 和 `model`。
- `toolCalls`：归一化后的完整工具调用。
- `usage`：归一化 token 用量。
- `finishReason`。
- `providerRequestId`：用于排查 Provider 请求。
- `rawResponse`：最终原始响应或最后一个流式 chunk。

## 当前边界

- 每个 `ChatRun` 只允许一个异步事件迭代器。
- Chat Completions 第一版只支持一个 choice，返回多个 choice 会产生 `protocol` 错误。
- `llm-client` 不自动执行工具。
- `llm-client` 不保存会话历史。
- `llm-client` 不自动在 Provider 协议之间降级。
- 思考事件只来自 Provider 明确暴露的摘要或 reasoning 字段，不代表模型隐藏推理。
- 当前仅实现 HTTP SSE，未实现 Responses WebSocket 模式。

更完整的接口契约和设计理由见 [LLM Client 接口设计](../../docs/llm-client-interface-design.md)。
