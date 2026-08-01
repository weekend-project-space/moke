import assert from 'node:assert/strict'
import test from 'node:test'
import { pageIdsToClose } from './tabClose'

test('selects the requested browser page close scope', () => {
  const pages = [1, 2, 3, 4]

  assert.deepEqual(pageIdsToClose(pages, 2, 'tab'), [2])
  assert.deepEqual(pageIdsToClose(pages, 2, 'others'), [1, 3, 4])
  assert.deepEqual(pageIdsToClose(pages, 2, 'right'), [3, 4])
})

test('returns no pages for a stale browser page', () => {
  assert.deepEqual(pageIdsToClose([1, 2], 3, 'tab'), [])
  assert.deepEqual(pageIdsToClose([1, 2], 3, 'others'), [])
  assert.deepEqual(pageIdsToClose([1, 2], 3, 'right'), [])
})
