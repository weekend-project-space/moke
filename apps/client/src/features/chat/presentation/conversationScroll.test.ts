import assert from 'node:assert/strict'
import test from 'node:test'

import { conversationScrollState, conversationTurnSpacerHeight } from './conversationScroll'

test('turn spacer fills only the missing space below the user message', () => {
  assert.equal(conversationTurnSpacerHeight({
    anchorScrollTop: 500,
    clientHeight: 600,
    currentSpacerHeight: 0,
    scrollHeight: 900,
  }), 200)
  assert.equal(conversationTurnSpacerHeight({
    anchorScrollTop: 500,
    clientHeight: 600,
    currentSpacerHeight: 200,
    scrollHeight: 1100,
  }), 200)
  assert.equal(conversationTurnSpacerHeight({
    anchorScrollTop: 500,
    clientHeight: 600,
    currentSpacerHeight: 0,
    scrollHeight: 1200,
  }), 0)
})

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
