import assert from 'node:assert/strict'
import test from 'node:test'

import { routeFromLegacyHash } from './routing/legacyRoute'

test('converts legacy task and session hashes to router paths', () => {
  assert.equal(routeFromLegacyHash('#tasks'), '/tasks')
  assert.equal(routeFromLegacyHash('#session=session_1'), '/chat/session_1')
  assert.equal(routeFromLegacyHash('#session=session%20one'), '/chat/session%20one')
})

test('leaves empty and current router hashes unchanged', () => {
  assert.equal(routeFromLegacyHash(''), null)
  assert.equal(routeFromLegacyHash('#/chat/session_1'), null)
  assert.equal(routeFromLegacyHash('#unknown=value'), null)
})
