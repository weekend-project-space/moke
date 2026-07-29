import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBrowserPreferences } from './preferences.js'

test('normalizeBrowserPreferences keeps supported browser link modes', () => {
  assert.deepEqual(normalizeBrowserPreferences({ linkOpenMode: 'new-tab' }), {
    browserHomeUrl: 'https://www.baidu.com/',
    linkOpenMode: 'new-tab',
    searchEngine: 'bing',
  })
})

test('normalizeBrowserPreferences falls back for invalid persisted options', () => {
  assert.deepEqual(normalizeBrowserPreferences({ linkOpenMode: 'invalid' as never, searchEngine: 'invalid' as never }), {
    browserHomeUrl: 'https://www.baidu.com/',
    linkOpenMode: 'current',
    searchEngine: 'bing',
  })
})

test('normalizeBrowserPreferences keeps supported search engines', () => {
  assert.equal(normalizeBrowserPreferences({ searchEngine: 'google' }).searchEngine, 'google')
  assert.equal(normalizeBrowserPreferences({ searchEngine: 'baidu' }).searchEngine, 'baidu')
})
