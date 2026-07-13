import assert from 'node:assert/strict'
import test from 'node:test'

import { conversationScrollState } from './conversationScroll'

test('conversation scroll state hides the jump action without overflow', () => {
  assert.deepEqual(
    conversationScrollState({ clientHeight: 500, scrollHeight: 400, scrollTop: 0 }),
    { isAtBottom: true, showJumpToBottom: false },
  )
})

test('conversation scroll state uses the bottom threshold', () => {
  assert.deepEqual(
    conversationScrollState({ clientHeight: 500, scrollHeight: 1000, scrollTop: 453 }),
    { isAtBottom: true, showJumpToBottom: false },
  )
  assert.deepEqual(
    conversationScrollState({ clientHeight: 500, scrollHeight: 1000, scrollTop: 452 }),
    { isAtBottom: false, showJumpToBottom: true },
  )
})
