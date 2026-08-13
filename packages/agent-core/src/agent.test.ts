import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from './agent.js';
import { createAgentRunSnapshot, reduceAgentEvent } from '@moke/agent-protocol';
import type { AgentEvent, AgentToolCall, ToolProvider } from '@moke/agent-protocol';
import type { ChatRequest, ChatResponse, ChatRun, LlmClient, LlmStreamEvent } from '@moke/llm-client';

function response(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return { id: 'response', runId: 'model-run', model: 'test', provider: 'test', status: 'completed', text: '', output: [], toolCalls: [], ...overrides };
}

function fakeRun(result: ChatResponse, events: LlmStreamEvent[] = []): ChatRun {
  return {
    id: result.runId,
    status: () => 'completed',
    snapshot: () => ({ id: result.runId, status: 'completed', text: result.text, thinking: '', toolCalls: result.toolCalls }),
    events: async function* () { for (const event of events) yield event; },
    result: async () => result,
    cancel: () => undefined,
  };
}

function event<T extends LlmStreamEvent['type']>(type: T, payload: Extract<LlmStreamEvent, { type: T }>['payload'], sequence: number): Extract<LlmStreamEvent, { type: T }> {
  return { version: 1, type, runId: 'model-run', sequence, timestamp: new Date().toISOString(), provider: { name: 'test' }, payload } as Extract<LlmStreamEvent, { type: T }>;
}

function model(chat: LlmClient['chat']): LlmClient {
  return { provider: 'test', defaultModel: 'test', chat, complete: async () => { throw new Error('unused'); } };
}

async function collect(run: ReturnType<ReturnType<typeof createAgent>['run']>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const item of run.events()) events.push(item);
  return events;
}

test('emits a complete text and reasoning lifecycle with stable message IDs', async () => {
  const llm = model(() => fakeRun(response({ text: 'hello' }), [
    event('thinking.delta', { delta: 'check', visibility: 'summary' }, 1),
    event('text.delta', { delta: 'hel' }, 2),
    event('text.delta', { delta: 'lo' }, 3),
  ]));
  const run = createAgent({ model: llm }).run({ threadId: 't1', input: 'hi' });
  const eventsPromise = collect(run);
  const result = await run.result();
  const events = await eventsPromise;
  assert.equal(result.message.content, 'hello');
  assert.deepEqual(events.map(item => item.type), [
    'run.started', 'step.started',
    'reasoning.started', 'reasoning_message.started', 'reasoning_message.content',
    'message.started', 'message.content', 'message.content', 'message.completed',
    'reasoning_message.completed', 'reasoning.completed',
    'step.completed', 'run.completed',
  ]);
  const textEvents = events.filter(item => item.type.startsWith('message.')) as Array<{ messageId: string }>;
  assert.equal(new Set(textEvents.map(item => item.messageId)).size, 1);
  assert.equal(result.messages.some(message => message.role === 'reasoning' && message.content === 'check'), true);
});

test('hides provider-exposed reasoning unless the run explicitly enables it', async () => {
  const thinking = event('thinking.delta', { delta: 'private', visibility: 'provider_exposed' }, 1);
  const hiddenRun = createAgent({ model: model(() => fakeRun(response({ text: 'ok' }), [thinking])) }).run({ threadId: 't1', input: 'hi' });
  const hiddenEventsPromise = collect(hiddenRun);
  const hiddenResult = await hiddenRun.result();
  const hiddenEvents = await hiddenEventsPromise;
  assert.equal(hiddenResult.messages.some(message => message.role === 'reasoning'), false);
  assert.equal(hiddenEvents.some(item => item.type.startsWith('reasoning')), false);

  const visibleRun = createAgent({ model: model(() => fakeRun(response({ text: 'ok' }), [thinking])) }).run({
    threadId: 't2',
    input: 'hi',
    metadata: { showRawReasoning: 'true' },
  });
  const visibleEventsPromise = collect(visibleRun);
  const visibleResult = await visibleRun.result();
  await visibleEventsPromise;
  assert.equal(visibleResult.messages.some(message => message.role === 'reasoning' && message.content === 'private'), true);
});

test('emits tool lifecycle and preserves tool call/result order for the next turn', async () => {
  const requests: ChatRequest[] = [];
  let turn = 0;
  const call = { callId: 'c1', name: 'add', argumentsJson: '{"a":1}', arguments: { a: 1 } };
  const llm = model((request: string | ChatRequest) => {
    requests.push(request as ChatRequest);
    turn++;
    return turn === 1
      ? fakeRun(response({ toolCalls: [call], output: [{ type: 'tool_call', toolCall: call }], finishReason: 'tool_calls' }), [
          event('tool_call.delta', { callId: 'c1', name: 'add', argumentsDelta: '{"a":1}' }, 1),
          event('tool_call.completed', call, 2),
        ])
      : fakeRun(response({ text: '2', output: [{ type: 'text', text: '2' }] }), [event('text.delta', { delta: '2' }, 1)]);
  });
  const tools: ToolProvider = {
    listTools: () => [{ name: 'add', description: 'Add numbers', parameters: { type: 'object' } }],
    validate: (toolCall: AgentToolCall) => ({ ...toolCall, parsedArguments: JSON.parse(toolCall.function.arguments) }),
    execute: async () => ({ content: '2', output: 2 }),
  };
  const run = createAgent({ model: llm, tools }).run({ threadId: 't1', input: '1+1', enabledToolNames: ['add'] });
  const eventsPromise = collect(run);
  const result = await run.result();
  const events = await eventsPromise;
  assert.equal(result.message.content, '2');
  assert.deepEqual(events.filter(item => item.type.startsWith('tool_')).map(item => item.type), [
    'tool_call.started', 'tool_call.args', 'tool_call.completed', 'tool_result.completed',
  ]);
  const toolStart = events.find(item => item.type === 'tool_call.started');
  assert.equal(toolStart?.type === 'tool_call.started' && typeof toolStart.parentMessageId, 'string');
  const nextInput = requests[1].input as Array<{ type: string; callId?: string }>;
  assert.deepEqual(nextInput.map(item => item.type), ['message', 'tool_call', 'tool_result']);
  assert.equal(nextInput[1].callId, 'c1');
  assert.equal(nextInput[2].callId, 'c1');
});

test('forwards tool context, media, and configured reasoning to the next model turn', async () => {
  const requests: ChatRequest[] = [];
  let turn = 0;
  const call = { callId: 'c1', name: 'inspect', argumentsJson: '{}', arguments: {} };
  const llm = model((request: string | ChatRequest) => {
    requests.push(request as ChatRequest);
    return ++turn === 1
      ? fakeRun(response({ toolCalls: [call], output: [{ type: 'tool_call', toolCall: call }] }))
      : fakeRun(response({ text: 'done' }));
  });
  const tools: ToolProvider = {
    listTools: () => [{ name: 'inspect', description: 'Inspect', parameters: { type: 'object' } }],
    validate: toolCall => ({ ...toolCall, parsedArguments: {} }),
    execute: async () => ({
      content: '{}',
      context: [{ description: 'inspection', value: 'observed value', role: 'user' }],
      media: [{ type: 'image', source: { type: 'url', value: 'data:image/png;base64,AAAA' } }],
    }),
  };
  await createAgent({ model: llm, tools }).run({
    threadId: 't1',
    input: 'inspect',
    metadata: { reasoningEffort: 'high' },
  }).result();
  assert.deepEqual(requests.map(request => request.reasoning), [{ effort: 'high' }, { effort: 'high' }]);
  const nextInput = requests[1].input as ChatRequest['input'];
  assert.equal(Array.isArray(nextInput), true);
  assert.deepEqual((nextInput as Array<{ type: string; role?: string }>).map(item => [item.type, item.role]), [
    ['message', 'user'],
    ['tool_call', undefined],
    ['tool_result', undefined],
    ['message', 'user'],
    ['message', 'user'],
  ]);
});

test('completes message and tool lifecycles when the provider only returns a final tool call', async () => {
  let turn = 0;
  const call = { callId: 'c1', name: 'read', argumentsJson: '{}', arguments: {} };
  const llm = model(() => ++turn === 1
    ? fakeRun(response({ toolCalls: [call], output: [{ type: 'tool_call', toolCall: call }] }))
    : fakeRun(response({ text: 'done' })));
  const tools: ToolProvider = {
    listTools: () => [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    validate: toolCall => ({ ...toolCall, parsedArguments: {} }),
    execute: async () => ({ content: 'data' }),
  };
  const run = createAgent({ model: llm, tools }).run({ threadId: 't1', input: 'read' });
  const eventsPromise = collect(run);
  await run.result();
  const events = await eventsPromise;
  const firstStepEvents = events.filter(item => item.stepId === events.find(candidate => candidate.type === 'step.started')?.stepId).map(item => item.type);
  assert.deepEqual(firstStepEvents, ['step.started', 'message.started', 'tool_call.started', 'tool_call.args', 'tool_call.completed', 'message.completed', 'tool_result.completed', 'step.completed']);
});

test('maps AG-UI style image URL/data sources and rejects unsupported modalities', async () => {
  const requests: ChatRequest[] = [];
  const llm = model((request: string | ChatRequest) => { requests.push(request as ChatRequest); return fakeRun(response({ text: 'ok' })); });
  await createAgent({ model: llm }).run({ threadId: 't1', input: [
    { type: 'text', text: 'inspect' },
    { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' }, metadata: { detail: 'high' } },
  ] }).result();
  const content = (requests[0].input as Array<{ content: unknown }>)[0].content;
  assert.deepEqual(content, [{ type: 'text', text: 'inspect' }, { type: 'image', url: 'data:image/png;base64,AAAA', detail: 'high' }]);
  assert.throws(() => createAgent({ model: llm }).run({ threadId: 't2', input: [{ type: 'audio', source: { type: 'url', value: 'https://example.com/a.wav' } }] }), /Unsupported model input type: audio/);
});

test('fails before model invocation when enabled backend tools are unavailable', async () => {
  let calls = 0;
  const llm = model(() => { calls++; return fakeRun(response()); });
  const tools: ToolProvider = { listTools: () => [], validate: () => { throw new Error('unused'); }, execute: async () => { throw new Error('unused'); } };
  const run = createAgent({ model: llm, tools }).run({ threadId: 't1', input: 'hi', enabledToolNames: ['missing'] });
  const eventsPromise = collect(run);
  await assert.rejects(run.result(), /Unknown or unavailable tools/);
  const events = await eventsPromise;
  assert.equal(calls, 0);
  assert.equal(events.at(-1)?.type, 'run.failed');
});

test('emits run.cancelled and propagates cancellation to the model run', async () => {
  let cancelled = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const chatRun: ChatRun = {
    id: 'model-run',
    status: () => 'running',
    snapshot: () => ({ id: 'model-run', status: 'running', text: '', thinking: '', toolCalls: [] }),
    events: async function* () { await pending; },
    result: async () => response(),
    cancel: () => { cancelled = true; release(); },
  };
  const run = createAgent({ model: model(() => chatRun) }).run({ threadId: 't1', input: 'wait' });
  const eventsPromise = collect(run);
  await new Promise(resolve => setImmediate(resolve));
  run.cancel('stop');
  await assert.rejects(run.result(), /stop/);
  const events = await eventsPromise;
  assert.equal(cancelled, true);
  assert.equal(events.at(-1)?.type, 'run.cancelled');
});

test('reducer deterministically rebuilds messages and terminal state from events', async () => {
  const llm = model(() => fakeRun(response({ text: 'hello' }), [event('text.delta', { delta: 'hello' }, 1)]));
  const run = createAgent({ model: llm }).run({ threadId: 't1', runId: 'r1', input: 'hi' });
  const eventsPromise = collect(run);
  const result = await run.result();
  const events = await eventsPromise;
  const snapshot = events.reduce(reduceAgentEvent, createAgentRunSnapshot('t1', 'r1'));
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(snapshot.messages, result.messages);
  assert.deepEqual(snapshot.usage, result.usage);
});
