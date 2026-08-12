import assert from 'node:assert/strict';
import test from 'node:test';

import { createLlmClient, LlmClientError, type LlmStreamEvent } from './index.js';

function sseResponse(events: Array<{ event?: string; data: unknown }>, headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  const wire = events.map(({ event, data }) => [
    event ? `event: ${event}` : '',
    `data: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
    '',
    '',
  ].filter((line, index) => line || index >= 2).join('\n')).join('');
  const split = Math.max(1, Math.floor(wire.length / 3));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(wire.slice(0, split)));
      controller.enqueue(encoder.encode(wire.slice(split, split * 2)));
      controller.enqueue(encoder.encode(wire.slice(split * 2)));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

async function collectEvents(iterable: AsyncIterable<LlmStreamEvent>) {
  const events: LlmStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('Responses API streams text, tools, usage and sends the expected request', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let requestUrl = '';
  const client = createLlmClient({
    provider: 'openai-responses',
    apiKey: 'secret',
    baseUrl: 'https://api.example.test/v1/',
    model: 'gpt-test',
    fetch: (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test' } } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hel' } },
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'lo' } },
        { event: 'response.output_text.done', data: { type: 'response.output_text.done', item_id: 'msg_1', text: 'Hello' } },
        { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '' } } },
        { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"city":' } },
        { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '"Shanghai"}' } },
        { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"Shanghai"}' } } },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: 'resp_1',
              model: 'gpt-test',
              output: [
                { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
                { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"Shanghai"}' },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        },
      ], { 'x-request-id': 'req_1' });
    }) as typeof fetch,
  });

  const run = client.chat({
    input: 'Hi',
    instructions: 'Be concise',
    tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' }, strict: true }],
    toolChoice: 'auto',
    previousResponseId: 'resp_0',
  });
  const eventsPromise = collectEvents(run.events());
  const result = await run.result();
  const events = await eventsPromise;

  assert.equal(requestUrl, 'https://api.example.test/v1/responses');
  assert.equal(requestBody?.model, 'gpt-test');
  assert.equal(requestBody?.input, 'Hi');
  assert.equal(requestBody?.instructions, 'Be concise');
  assert.equal(requestBody?.previous_response_id, 'resp_0');
  assert.equal(requestBody?.stream, true);
  assert.equal(result.text, 'Hello');
  assert.deepEqual(result.toolCalls[0]?.arguments, { city: 'Shanghai' });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(result.providerRequestId, 'req_1');
  assert.equal(run.status(), 'completed');
  assert.deepEqual(events.map((event) => event.type), [
    'run.started',
    'text.delta',
    'text.delta',
    'text.completed',
    'tool_call.delta',
    'tool_call.delta',
    'tool_call.completed',
    'usage.updated',
    'run.completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('Responses API forwards unknown semantic events without hiding them', async () => {
  const raw: unknown[] = [];
  const client = createLlmClient({
    provider: 'openai-responses',
    apiKey: 'secret',
    model: 'gpt-test',
    fetch: (async () => sseResponse([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_2' } } },
      { event: 'response.future_event', data: { type: 'response.future_event', value: 42 } },
      { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_2', model: 'gpt-test', output: [] } } },
    ])) as typeof fetch,
  });

  await client.chat('Hello', {
    onUnmappedRawEvent(event) { raw.push(event.raw); },
    onCompleted() {},
    onFailed(error) { throw error; },
  }).result();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(raw, [{ type: 'response.future_event', value: 42 }]);
});

test('Chat Completions streams content, joins tool calls, usage and [DONE]', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const callbacks: string[] = [];
  const client = createLlmClient({
    provider: 'openai-chat-completions',
    apiKey: 'secret',
    model: 'gpt-4o-mini',
    fetch: (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { data: { id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } },
        { data: { id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: 'Hi ' }, finish_reason: null }] } },
        { data: { id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } }] }, finish_reason: null }] } },
        { data: { id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: 'tool_calls' }] } },
        { data: { id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } },
        { data: '[DONE]' },
      ], { 'x-request-id': 'req_chat' });
    }) as typeof fetch,
  });

  const result = await client.chat({
    input: [{ type: 'message', role: 'user', content: 'Weather?' }],
    instructions: 'Be useful',
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
  }, {
    onTextDelta(delta) { callbacks.push(`text:${delta.text}`); },
    onToolCallCompleted(toolCall) { callbacks.push(`tool:${toolCall.name}`); },
    onCompleted() { callbacks.push('completed'); },
    onFailed(error) { throw error; },
  }).result();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requestBody?.stream, true);
  assert.equal(requestBody?.n, 1);
  assert.deepEqual(requestBody?.stream_options, { include_usage: true });
  assert.deepEqual((requestBody?.messages as unknown[])[0], { role: 'developer', content: 'Be useful' });
  assert.equal(result.text, 'Hi ');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls[0]?.arguments, { city: 'Paris' });
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 4, totalTokens: 12 });
  assert.deepEqual(callbacks, ['text:Hi ', 'tool:get_weather', 'completed']);
});

test('OpenAI-compatible applies declared compatibility switches', async () => {
  let body: Record<string, unknown> | undefined;
  const client = createLlmClient({
    provider: 'openai-compatible',
    apiKey: 'local',
    baseUrl: 'http://localhost:8080/v1',
    model: 'local-model',
    compatible: {
      supportsDeveloperRole: false,
      supportsStreamUsage: false,
      supportsParallelToolCalls: false,
    },
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { data: { id: 'chat_local', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } },
        { data: '[DONE]' },
      ]);
    }) as typeof fetch,
  });

  const result = await client.complete({ input: 'Hello', instructions: 'System', parallelToolCalls: true });
  assert.equal(result.text, 'ok');
  assert.deepEqual((body?.messages as unknown[])[0], { role: 'system', content: 'System' });
  assert.equal(body?.stream_options, undefined);
  assert.equal(body?.parallel_tool_calls, undefined);
});

test('Chat Completions preserves refusal output and exposes its raw delta', async () => {
  const rawTypes: string[] = [];
  const client = createLlmClient({
    provider: 'openai-chat-completions',
    apiKey: 'secret',
    model: 'gpt-test',
    fetch: (async () => sseResponse([
      { data: { id: 'chat_refusal', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { refusal: 'Cannot comply' }, finish_reason: 'content_filter' }] } },
      { data: '[DONE]' },
    ])) as typeof fetch,
  });

  const result = await client.chat('Hello', {
    onUnmappedRawEvent(event) { rawTypes.push(event.type); },
    onCompleted() {},
    onFailed(error) { throw error; },
  }).result();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(result.output, [{ type: 'refusal', text: 'Cannot comply' }]);
  assert.deepEqual(rawTypes, ['chat.completion.refusal.delta']);
});

test('Chat Completions rejects multiple choices instead of mixing text', async () => {
  const client = createLlmClient({
    provider: 'openai-chat-completions',
    apiKey: 'secret',
    model: 'gpt-test',
    fetch: (async () => sseResponse([
      { data: { id: 'chat_2', object: 'chat.completion.chunk', choices: [
        { index: 0, delta: { content: 'a' }, finish_reason: null },
        { index: 1, delta: { content: 'b' }, finish_reason: null },
      ] } },
      { data: '[DONE]' },
    ])) as typeof fetch,
  });

  await assert.rejects(client.complete('Hello'), (error: unknown) => {
    assert.ok(error instanceof LlmClientError);
    assert.equal(error.kind, 'protocol');
    return true;
  });
});

test('HTTP errors are normalized with request metadata', async () => {
  const client = createLlmClient({
    provider: 'openai-responses',
    apiKey: 'secret',
    model: 'gpt-test',
    fetch: (async () => new Response(JSON.stringify({ error: { message: 'Too many requests', code: 'rate_limit' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-request-id': 'req_limit' },
    })) as typeof fetch,
  });

  await assert.rejects(client.complete('Hello'), (error: unknown) => {
    assert.ok(error instanceof LlmClientError);
    assert.equal(error.kind, 'rate_limit');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 2000);
    assert.equal(error.providerRequestId, 'req_limit');
    return true;
  });
});

test('retries retryable failures only before the provider stream starts', async () => {
  let requests = 0;
  const client = createLlmClient({
    provider: 'openai-responses',
    apiKey: 'secret',
    model: 'gpt-test',
    maxRetries: 1,
    fetch: (async () => {
      requests += 1;
      if (requests === 1) return new Response('{"error":{"message":"temporary"}}', { status: 503 });
      return sseResponse([
        { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_retry' } } },
        { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_retry', model: 'gpt-test', output: [] } } },
      ]);
    }) as typeof fetch,
  });

  const result = await client.complete('Hello');
  assert.equal(result.id, 'resp_retry');
  assert.equal(requests, 2);
});

test('timeout has distinct error semantics', async () => {
  const client = createLlmClient({
    provider: 'openai-responses',
    apiKey: 'secret',
    model: 'gpt-test',
    timeoutMs: 10,
    fetch: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as typeof fetch,
  });

  await assert.rejects(client.complete('Hello'), (error: unknown) => {
    assert.ok(error instanceof LlmClientError);
    assert.equal(error.kind, 'timeout');
    return true;
  });
});

test('invalid completed tool arguments fail instead of becoming an empty object', async () => {
  const client = createLlmClient({
    provider: 'openai-chat-completions',
    apiKey: 'secret',
    model: 'gpt-test',
    fetch: (async () => sseResponse([
      { data: { id: 'chat_bad_tool', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'tool', arguments: '{bad' } }] }, finish_reason: 'tool_calls' }] } },
      { data: '[DONE]' },
    ])) as typeof fetch,
  });

  await assert.rejects(client.complete('Hello'), (error: unknown) => {
    assert.ok(error instanceof LlmClientError);
    assert.equal(error.kind, 'protocol');
    return true;
  });
});

test('cancel is idempotent and produces only the cancelled terminal event', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const client = createLlmClient({
    provider: 'openai-responses',
    apiKey: 'secret',
    model: 'gpt-test',
    fetch: (async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }))) as typeof fetch,
  });
  const terminals: string[] = [];
  const run = client.chat('Hello', {
    onCompleted() { terminals.push('completed'); },
    onFailed() { terminals.push('failed'); },
    onCancelled() { terminals.push('cancelled'); },
  });
  const eventsPromise = collectEvents(run.events());
  await new Promise((resolve) => setTimeout(resolve, 0));
  run.cancel('user cancelled');
  run.cancel('again');
  controller.close();

  await assert.rejects(run.result(), (error: unknown) => error instanceof LlmClientError && error.kind === 'cancelled');
  const events = await eventsPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(run.status(), 'cancelled');
  assert.deepEqual(events.map((event) => event.type), ['run.cancelled']);
  assert.deepEqual(terminals, ['cancelled']);
});

test('handler failures are isolated from the stream', async () => {
  const handlerErrors: unknown[] = [];
  const client = createLlmClient({
    provider: 'openai-chat-completions',
    apiKey: 'secret',
    model: 'gpt-test',
    diagnostics: { onHandlerError(error) { handlerErrors.push(error); } },
    fetch: (async () => sseResponse([
      { data: { id: 'chat_3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } },
      { data: '[DONE]' },
    ])) as typeof fetch,
  });

  const result = await client.chat('Hello', {
    onTextDelta() { throw new Error('UI failed'); },
    onCompleted() {},
    onFailed(error) { throw error; },
  }).result();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(result.text, 'ok');
  assert.equal(handlerErrors.length, 1);
});
