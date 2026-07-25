import test from 'node:test'
import assert from 'node:assert/strict'
import { createSerialTaskQueue } from './serialTaskQueue'

test('serial task queue preserves request order', async () => {
  const queue = createSerialTaskQueue()
  const events: string[] = []

  const first = queue.enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    events.push('first')
    return 1
  })
  const second = queue.enqueue(async () => {
    events.push('second')
    return 2
  })

  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.deepEqual(events, ['first', 'second'])
})

test('serial task queue continues after a failed task', async () => {
  const queue = createSerialTaskQueue()
  const failed = queue.enqueue(async () => {
    throw new Error('expected')
  })
  const next = queue.enqueue(async () => 'ok')

  await assert.rejects(failed, /expected/)
  assert.equal(await next, 'ok')
})
