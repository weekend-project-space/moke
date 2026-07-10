import assert from 'node:assert/strict'
import test from 'node:test'

import { createLatestRequestGuard } from './latestRequest.js'

test('createLatestRequestGuard only accepts the latest request', () => {
  const guard = createLatestRequestGuard()
  const first = guard.start()
  const second = guard.start()

  assert.equal(first.signal.aborted, true)
  assert.equal(first.isCurrent(), false)
  assert.equal(second.isCurrent(), true)
})
