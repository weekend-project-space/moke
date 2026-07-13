import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelKwargs, resolveChatModelSettings } from './llm-client.js';

test('createModelKwargs maps llama.cpp reasoning settings', () => {
  const settings = resolveChatModelSettings({
    reasoningEffort: 'max',
    reasoningProvider: 'llama.cpp',
    showRawReasoning: true,
  });

  assert.deepEqual(createModelKwargs(settings), {
    return_progress: true,
    reasoning_format: 'auto',
    chat_template_kwargs: {
      enable_thinking: true,
    },
    thinking_budget_tokens: 2048,
    reasoning_control: true,
    backend_sampling: false,
  });
});

test('createModelKwargs does not send provider-specific fields for standard providers', () => {
  const settings = resolveChatModelSettings({
    reasoningEffort: 'high',
    reasoningProvider: 'none',
    showRawReasoning: true,
  });

  assert.deepEqual(createModelKwargs(settings), {});
});

test('resolveChatModelSettings keeps provider type explicit', () => {
  assert.equal(resolveChatModelSettings().type, 'openai-compatible');
  assert.equal(resolveChatModelSettings({ type: 'openai-responses' }).type, 'openai-responses');
});
