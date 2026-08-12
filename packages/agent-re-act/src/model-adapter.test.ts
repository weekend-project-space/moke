import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeContentManager } from '@moke/agent-runtime';
import { ChatCompletionsAdapter, normalizeStreamToolCalls, normalizeTokenUsage, ResponsesAdapter } from './model-adapter.js';
import type { ChatModelSettings } from './llm-client.js';

const settings: ChatModelSettings = {
  apiKey: 'test',
  apiBaseUrl: 'http://localhost:8080/v1',
  maxRetries: 0,
  model: 'test-model',
  type: 'openai-compatible',
  reasoningEffort: 'off',
  reasoningProvider: 'none',
  showRawReasoning: false,
  timeoutMs: 1000,
};

const contentManager: RuntimeContentManager = {
  addSkill: (skill) => ({ status: 'activated', content: skill.content }),
  buildInitialContext: () => [
    { authority: 'trusted', content: 'Trusted catalog' },
    { authority: 'user', content: 'Workspace catalog' },
  ],
};

const initialInput = {
  context: { workspace: '.', contentManager },
  history: [],
  input: 'Current request',
  attachments: [],
  runtimeTools: [],
};

test('Responses adapter maps trusted context to developer and appends new context after tool output', () => {
  const adapter = new ResponsesAdapter({ ...settings, type: 'openai-responses' }, []);
  const state = adapter.createInitialState(initialInput);

  assert.deepEqual(state.responses?.slice(0, 4).map((item) => 'role' in item ? item.role : item.type), [
    'developer',
    'developer',
    'user',
    'user',
  ]);

  adapter.appendToolResult(state, { callId: 'call_1', name: 'activate_skill', output: { status: 'activated' } });
  adapter.appendContext(state, [{ authority: 'user', content: 'Activated instructions' }]);

  assert.deepEqual(state.responses?.slice(-2).map((item) => 'role' in item ? item.role : item.type), [
    'function_call_output',
    'user',
  ]);
});

test('OpenAI-compatible adapter falls trusted context back to system messages', () => {
  const adapter = new ChatCompletionsAdapter(settings, []);
  const state = adapter.createInitialState(initialInput);

  assert.deepEqual(state.langchain?.map((message) => message.getType()), [
    'system',
    'system',
    'human',
    'human',
  ]);

  const prefix = state.langchain?.slice();
  adapter.appendToolResult(state, { callId: 'call_1', name: 'activate_skill', output: { status: 'activated' } });
  adapter.appendContext(state, [{ authority: 'trusted', content: 'Activated instructions' }]);

  assert.deepEqual(state.langchain?.slice(0, prefix?.length), prefix);
  assert.deepEqual(state.langchain?.slice(-2).map((message) => message.getType()), ['tool', 'system']);
});

test('Responses adapter appends tool images as model image input', () => {
  const adapter = new ResponsesAdapter({ ...settings, type: 'openai-responses' }, []);
  const state = adapter.createInitialState(initialInput);

  adapter.appendToolResult(state, {
    callId: 'call_1',
    name: 'view_image',
    output: { path: 'image.png' },
    images: [{ data_url: 'data:image/png;base64,AA==' }],
  });

  assert.deepEqual(state.responses?.slice(-2), [
    { type: 'function_call_output', call_id: 'call_1', output: '{"path":"image.png"}' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
  ]);
});

test('OpenAI-compatible adapter appends tool images as a human image message', () => {
  const adapter = new ChatCompletionsAdapter(settings, []);
  const state = adapter.createInitialState(initialInput);

  adapter.appendToolResult(state, {
    callId: 'call_1',
    name: 'view_image',
    output: { path: 'image.png' },
    images: [{ data_url: 'data:image/png;base64,AA==' }],
  });

  assert.deepEqual(state.langchain?.slice(-2).map((message) => message.getType()), ['tool', 'human']);
  assert.deepEqual(state.langchain?.at(-1)?.content, [{
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AA==' },
  }]);
});

test('provider token usage normalizes DeepSeek and OpenAI cache fields', () => {
  assert.deepEqual(normalizeTokenUsage({
    prompt_tokens: 120,
    completion_tokens: 20,
    prompt_cache_hit_tokens: 90,
    prompt_cache_miss_tokens: 30,
  }), {
    input_tokens: 120,
    output_tokens: 20,
    cached_input_tokens: 90,
    uncached_input_tokens: 30,
  });
  assert.deepEqual(normalizeTokenUsage({
    input_tokens: 50,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 40 },
  }), {
    input_tokens: 50,
    output_tokens: 10,
    cached_input_tokens: 40,
    uncached_input_tokens: 10,
  });
});

test('OpenAI-compatible adapter joins split tool name and arguments', () => {
  assert.deepEqual(normalizeStreamToolCalls([
    { id: 'call_name', name: 'ask_user', args: {} },
    { id: 'call_args', name: '', args: { question: 'Choose:', options: ['One', 'Two'] } },
  ]), [{
    id: 'call_name',
    name: 'ask_user',
    args: { question: 'Choose:', options: ['One', 'Two'] },
  }]);
});

test('OpenAI-compatible adapter does not merge unrelated tool calls', () => {
  assert.deepEqual(normalizeStreamToolCalls([
    { id: 'call_1', name: 'search', args: { query: 'one' } },
    { id: 'call_2', name: '', args: { query: 'two' } },
    { id: 'call_3', name: 'read_file', args: { path: 'README.md' } },
  ]), [
    { id: 'call_1', name: 'search', args: { query: 'one' } },
    { id: 'call_3', name: 'read_file', args: { path: 'README.md' } },
  ]);
  assert.deepEqual(normalizeStreamToolCalls([
    { id: 'call_1', name: 'search', args: {} },
    { id: 'fragment_1', name: '', args: {} },
    { id: 'fragment_2', name: '', args: { query: 'two' } },
  ]), [{ id: 'call_1', name: 'search', args: {} }]);
});
