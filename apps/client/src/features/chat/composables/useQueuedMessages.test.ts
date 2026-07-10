import assert from 'node:assert/strict'
import test from 'node:test'

import { useQueuedMessages } from './useQueuedMessages.js'

function message(content: string) {
  return { content, attachments: [] }
}

test('useQueuedMessages keeps queued messages scoped to one session', () => {
  const queue = useQueuedMessages(3)

  assert.equal(queue.enqueue('session-a', message('first')), true)
  assert.equal(queue.enqueue('session-b', message('second')), true)
  assert.equal(queue.count.value, 1)
  assert.equal(queue.takeNext('session-a'), null)
  assert.equal(queue.takeNext('session-b')?.content, 'second')
})

test('useQueuedMessages clears the stop flag when it sends the next message', () => {
  const queue = useQueuedMessages(3)

  queue.enqueue('session-a', message('first'))
  queue.enqueue('session-a', message('second'))
  queue.requestStop()

  assert.equal(queue.stopRequested.value, true)
  assert.equal(queue.takeNext('session-a')?.content, 'first')
  assert.equal(queue.stopRequested.value, false)
  assert.equal(queue.count.value, 1)
})
