import assert from 'node:assert/strict';
import test from 'node:test';

import type { Message } from '../../protocol/src/index.js';
import { selectRecentHistory } from './run-manager.js';

function message(input: Partial<Message> & Pick<Message, 'role'>): Message {
  return {
    id: `msg_${Math.random()}`,
    content: '',
    created_at: new Date().toISOString(),
    ...input,
  } as Message;
}

test('selectRecentHistory keeps a complete tool-call group at the cutoff', () => {
  const history: Message[] = [
    message({ role: 'user', content: 'old' }),
    message({ role: 'assistant', tool_calls: [
      { id: 'call_1', name: 'first', args: {} },
      { id: 'call_2', name: 'second', args: {} },
    ] }),
    message({ role: 'tool', tool_call_id: 'call_1', name: 'first' }),
    message({ role: 'tool', tool_call_id: 'call_2', name: 'second' }),
    message({ role: 'assistant', content: 'done' }),
  ];

  const selected = selectRecentHistory(history, 3);

  assert.equal(selected[0]?.role, 'assistant');
  assert.equal(selected.length, 4);
  assert.deepEqual(selected.slice(1, 3).map((item) => item.role), ['tool', 'tool']);
});

test('selectRecentHistory uses the requested tail when it starts at a turn boundary', () => {
  const history: Message[] = [
    message({ role: 'user', content: 'old' }),
    message({ role: 'assistant', content: 'old answer' }),
    message({ role: 'user', content: 'new' }),
    message({ role: 'assistant', content: 'new answer' }),
  ];

  assert.deepEqual(selectRecentHistory(history, 2), history.slice(2));
});
