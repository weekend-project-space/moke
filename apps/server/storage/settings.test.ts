import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeProvider,
  normalizeProviderReasoningEffort,
  normalizeProviderReasoningProvider,
  normalizeProviderShowRawReasoning,
  normalizeProviderType,
  providerToModelSettings,
} from './settings.js';

test('normalizeProviderReasoningEffort accepts known values', () => {
  assert.equal(normalizeProviderReasoningEffort('off'), 'off');
  assert.equal(normalizeProviderReasoningEffort('low'), 'low');
  assert.equal(normalizeProviderReasoningEffort('medium'), 'medium');
  assert.equal(normalizeProviderReasoningEffort('high'), 'high');
  assert.equal(normalizeProviderReasoningEffort('max'), 'max');
  assert.equal(normalizeProviderReasoningEffort('ultra'), 'max');
});

test('normalizeProviderReasoningEffort falls back to medium', () => {
  assert.equal(normalizeProviderReasoningEffort('verbose'), 'medium');
  assert.equal(normalizeProviderReasoningEffort('brief'), 'medium');
  assert.equal(normalizeProviderReasoningEffort('detailed'), 'medium');
  assert.equal(normalizeProviderReasoningEffort(undefined), 'medium');
});

test('providerToModelSettings includes reasoning effort', () => {
  const provider = normalizeProvider({
    reasoningEffort: 'max',
    reasoningProvider: 'llama.cpp',
    showRawReasoning: true,
  });

  assert.equal(provider.reasoningEffort, 'max');
  assert.equal(provider.reasoningProvider, 'llama.cpp');
  assert.equal(provider.showRawReasoning, true);
  assert.equal(providerToModelSettings(provider).reasoningEffort, 'max');
  assert.equal(providerToModelSettings(provider).reasoningProvider, 'llama.cpp');
  assert.equal(providerToModelSettings(provider).showRawReasoning, true);
});

test('normalizeProviderType accepts OpenAI-compatible and Responses providers', () => {
  assert.equal(normalizeProviderType('openai-compatible'), 'openai-compatible');
  assert.equal(normalizeProviderType('openai-responses'), 'openai-responses');
  assert.equal(normalizeProviderType('unknown'), 'openai-compatible');
});

test('providerToModelSettings includes provider type', () => {
  const provider = normalizeProvider({ type: 'openai-responses' });

  assert.equal(provider.type, 'openai-responses');
  assert.equal(providerToModelSettings(provider).type, 'openai-responses');
});

test('normalizeProviderReasoningProvider accepts llama.cpp only', () => {
  assert.equal(normalizeProviderReasoningProvider('llama.cpp'), 'llama.cpp');
  assert.equal(normalizeProviderReasoningProvider('openai'), 'none');
});

test('normalizeProviderShowRawReasoning accepts booleans and strings', () => {
  assert.equal(normalizeProviderShowRawReasoning(true), true);
  assert.equal(normalizeProviderShowRawReasoning('true'), true);
  assert.equal(normalizeProviderShowRawReasoning(false), false);
  assert.equal(normalizeProviderShowRawReasoning('false'), false);
});
