import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from './conversation'
import { reconcileSessionMessages, serverCoversLiveMessages } from './reconcileMessages'

test('reconciliation preserves live messages missing from a stale session snapshot', () => {
  const server: Message[] = [{ id: 'user_1', role: 'user', content: 'question' }]
  const live: Message[] = [...server, { id: 'assistant_1', role: 'assistant', content: 'answer' }]
  assert.deepEqual(reconcileSessionMessages(server, live), live)
  assert.equal(serverCoversLiveMessages(server, live), false)
})

test('reconciliation keeps a more complete live message with the same id', () => {
  const server: Message[] = [{ id: 'assistant_1', role: 'assistant', content: '' }]
  const live: Message[] = [{
    id: 'assistant_1', role: 'assistant', content: 'working', reasoning: 'checked',
    tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }],
  }]
  assert.deepEqual(reconcileSessionMessages(server, live), live)
  assert.equal(serverCoversLiveMessages(server, live), false)
})

test('reconciliation preserves an unpersisted optimistic user message without duplicating it later', () => {
  const optimistic: Message = { role: 'user', content: 'question' }
  assert.deepEqual(reconcileSessionMessages([], [optimistic]), [optimistic])
  assert.equal(serverCoversLiveMessages([], [optimistic]), false)

  const persisted: Message = { id: 'user_1', role: 'user', content: 'question' }
  assert.deepEqual(reconcileSessionMessages([persisted], [optimistic]), [persisted])
  assert.equal(serverCoversLiveMessages([persisted], [optimistic]), true)
})
