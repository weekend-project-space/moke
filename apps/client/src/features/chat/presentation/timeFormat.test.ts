import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSessionTime, formatTimelineTime } from './timeFormat'

test('formatSessionTime handles invalid and same-day values', () => {
  const now = new Date(2026, 6, 10, 12, 0)
  const sameDay = new Date(2026, 6, 10, 9, 30)

  assert.equal(formatSessionTime('invalid', now), 'Just now')
  assert.match(formatSessionTime(sameDay.toISOString(), now), /09:30/)
})

test('formatTimelineTime labels yesterday and older years', () => {
  const now = new Date(2026, 6, 10, 12, 0)
  const yesterday = new Date(2026, 6, 9, 8, 15)
  const olderYear = new Date(2025, 11, 31, 23, 0)

  assert.match(formatTimelineTime(yesterday.getTime(), now), /^Yesterday /)
  assert.match(formatTimelineTime(olderYear.getTime(), now), /^2025 /)
})
