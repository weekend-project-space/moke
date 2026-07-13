import assert from 'node:assert/strict'
import test from 'node:test'

import { formatProcessGroupStatus } from './processDisplay'

const group = {
  label: 'Process details',
  items: [],
  hasError: false,
  startedAt: 1_000,
  endedAt: 4_000,
}

test('formatProcessGroupStatus distinguishes active and completed work', () => {
  assert.deepEqual(formatProcessGroupStatus(group, true, 5_000), {
    durationLabel: '4s',
    label: 'Working · 4s',
  })
  assert.deepEqual(formatProcessGroupStatus(group), {
    durationLabel: '3s',
    label: 'Processed · 3s',
  })
})
