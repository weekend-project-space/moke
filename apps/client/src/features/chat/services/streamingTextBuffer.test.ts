import assert from 'node:assert/strict'
import test from 'node:test'

import { createStreamingTextBuffer } from './streamingTextBuffer'

test('streaming buffer batches deltas by session and flushes the accumulated text', () => {
  let currentTime = 100
  let frameCallback: (() => void) | undefined
  let timerCallback: (() => void) | undefined
  const flushed: Array<[string, string]> = []
  const buffer = createStreamingTextBuffer({
    now: () => currentTime,
    setTimer: (callback) => {
      timerCallback = callback
      return 1
    },
    clearTimer: () => undefined,
    requestFrame: (callback) => {
      frameCallback = callback
      return 2
    },
    cancelFrame: () => undefined,
    onFlush: (sessionId, text) => flushed.push([sessionId, text]),
  })

  buffer.append('session_1', 'hel')
  buffer.append('session_1', 'lo')
  assert.ok(frameCallback)
  frameCallback()
  assert.deepEqual(flushed, [['session_1', 'hello']])

  currentTime = 110
  buffer.append('session_1', '!')
  assert.ok(timerCallback)
  timerCallback()
  assert.ok(frameCallback)
  frameCallback()
  assert.deepEqual(flushed.at(-1), ['session_1', 'hello!'])
})

test('clearing a streaming buffer cancels pending work and flushes an empty value', () => {
  const cancelledFrames: number[] = []
  const flushed: Array<[string, string]> = []
  const buffer = createStreamingTextBuffer({
    now: () => 100,
    setTimer: () => 1,
    clearTimer: () => undefined,
    requestFrame: () => 7,
    cancelFrame: (frame) => cancelledFrames.push(frame),
    onFlush: (sessionId, text) => flushed.push([sessionId, text]),
  })

  buffer.append('session_1', 'partial')
  buffer.clear('session_1')

  assert.deepEqual(cancelledFrames, [7])
  assert.deepEqual(flushed, [['session_1', '']])
})
