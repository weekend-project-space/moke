import assert from 'node:assert/strict';
import test from 'node:test';

import { AIMessageChunk } from '@langchain/core/messages';

import { createHistoryMessages, createSystemPrompt, getMessageText, getReasoningText } from './messages.js';

test('system prompt keeps hidden reasoning private by default', () => {
  const prompt = createSystemPrompt([]);

  assert.match(prompt, /Do not include hidden reasoning/);
  assert.match(prompt, /<think>/);
  assert.match(prompt, /keep it separate from the final answer/);
});

test('assistant reasoning is not included in model history', () => {
  const history = createHistoryMessages([
    {
      id: 'msg_assistant',
      role: 'assistant',
      content: 'Visible answer',
      reasoning: 'Hidden reasoning',
      created_at: new Date().toISOString(),
    },
  ]);

  assert.equal(history.length, 1);
  assert.equal(getMessageText(history[0]), 'Visible answer');
});

test('reasoning text preserves streaming whitespace', () => {
  const chunk = new AIMessageChunk({
    content: '',
    additional_kwargs: {
      reasoning_content: 'I need ',
    },
  });

  assert.equal(getReasoningText(chunk), 'I need ');
});
