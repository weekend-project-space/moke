import assert from 'node:assert/strict';
import test from 'node:test';

import { askUserSchema, normalizeAskOptions } from './control-tools.js';

test('ask_user accepts string options and assigns its own ids', () => {
  assert.equal(askUserSchema.safeParse({ question: 'Stack?', options: ['React', 'Vue'] }).success, true);
  assert.equal(askUserSchema.safeParse({
    question: 'Stack?',
    options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }],
  }).success, false);
  assert.deepEqual(normalizeAskOptions(['React', 'Vue']), [
    { id: 'option_1', label: 'React' },
    { id: 'option_2', label: 'Vue' },
  ]);
});

test('normalizeAskOptions ignores ids from legacy object options', () => {
  assert.deepEqual(normalizeAskOptions([
    { id: 'model_id', label: 'React' },
    { id: 'another_id', label: 'Vue' },
  ]), [
    { id: 'option_1', label: 'React' },
    { id: 'option_2', label: 'Vue' },
  ]);
});
