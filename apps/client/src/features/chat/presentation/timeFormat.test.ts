import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSessionTime } from './timeFormat'

test('formatSessionTime handles invalid and same-day values', () => {
  const now = new Date(2026, 6, 10, 12, 0)
  const sameDay = new Date(2026, 6, 10, 9, 30)

  assert.equal(formatSessionTime('invalid', now), 'Just now')
  assert.match(formatSessionTime(sameDay.toISOString(), now), /09:30/)
})
