import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeProvider,
  normalizeProviderReasoningEffort,
  normalizeProviderReasoningProvider,
  normalizeProviderShowRawReasoning,
  providerToModelSettings,
} from './settings.js';

test('normalizeProviderReasoningEffort accepts known values', () => {
  assert.equal(normalizeProviderReasoningEffort('off'), 'off');
  assert.equal(normalizeProviderReasoningEffort('low'), 'low');
  assert.equal(normalizeProviderReasoningEffort('medium'), 'medium');
  assert.equal(normalizeProviderReasoningEffort('high'), 'high');
  assert.equal(normalizeProviderReasoningEffort('ultra'), 'ultra');
});

test('normalizeProviderReasoningEffort falls back to medium', () => {
  assert.equal(normalizeProviderReasoningEffort('verbose'), 'medium');
  assert.equal(normalizeProviderReasoningEffort('brief'), 'medium');
  assert.equal(normalizeProviderReasoningEffort('detailed'), 'medium');
  assert.equal(normalizeProviderReasoningEffort(undefined), 'medium');
});

test('providerToModelSettings includes reasoning effort', () => {
  const provider = normalizeProvider({
    reasoningEffort: 'ultra',
    reasoningProvider: 'llama.cpp',
    showRawReasoning: true,
  });

  assert.equal(provider.reasoningEffort, 'ultra');
  assert.equal(provider.reasoningProvider, 'llama.cpp');
  assert.equal(provider.showRawReasoning, true);
  assert.equal(providerToModelSettings(provider).reasoningEffort, 'ultra');
  assert.equal(providerToModelSettings(provider).reasoningProvider, 'llama.cpp');
  assert.equal(providerToModelSettings(provider).showRawReasoning, true);
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
