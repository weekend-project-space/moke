import assert from 'node:assert/strict'
import test from 'node:test'

import type { Message } from './conversation'
import { appendOptimisticUserMessage } from './optimisticMessages'

test('optimistic message rollback removes the exact appended message', () => {
  const messages: Message[] = [
    { role: 'user', content: 'same', created_at: '2026-01-01T00:00:00.000Z' },
  ]
  const optimistic = appendOptimisticUserMessage(messages, {
    content: 'same',
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  assert.equal(messages.length, 2)
  assert.equal(optimistic.rollback(), true)
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.content, 'same')
  assert.equal(optimistic.rollback(), false)
})

test('optimistic message includes attachments only when provided', () => {
  const messages: Message[] = []
  const attachment = {
    id: 'image_1',
    kind: 'image' as const,
    mime_type: 'image/png',
    data_url: 'data:image/png;base64,abc',
  }

  const optimistic = appendOptimisticUserMessage(messages, {
    content: '',
    attachments: [attachment],
  })

  assert.deepEqual(optimistic.message.attachments, [attachment])
})
