import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBrowserPreferences } from './browserPreferences.js'

test('normalizeBrowserPreferences keeps supported browser link modes', () => {
  assert.deepEqual(normalizeBrowserPreferences({ linkOpenMode: 'new-tab' }), {
    browserHomeUrl: 'https://www.baidu.com/',
    linkOpenMode: 'new-tab',
  })
})

test('normalizeBrowserPreferences falls back for invalid persisted link modes', () => {
  assert.deepEqual(normalizeBrowserPreferences({ linkOpenMode: 'invalid' as never }), {
    browserHomeUrl: 'https://www.baidu.com/',
    linkOpenMode: 'current',
  })
})
