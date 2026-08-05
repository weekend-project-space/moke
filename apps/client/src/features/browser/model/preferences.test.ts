import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBrowserPreferences } from './preferences.js'

test('normalizeBrowserPreferences keeps supported search engines', () => {
  assert.deepEqual(normalizeBrowserPreferences({ searchEngine: 'google' }), {
    searchEngine: 'google',
  })
})

test('normalizeBrowserPreferences falls back for invalid persisted options', () => {
  assert.deepEqual(normalizeBrowserPreferences({ searchEngine: 'invalid' as never }), {
    searchEngine: 'bing',
  })
})

test('normalizeBrowserPreferences drops removed home settings', () => {
  assert.deepEqual(normalizeBrowserPreferences({
    browserHomeUrl: 'https://example.com',
    linkOpenMode: 'new-tab',
  } as never), {
    searchEngine: 'bing',
  })
})

test('normalizeBrowserPreferences keeps supported alternate search engines', () => {
  assert.equal(normalizeBrowserPreferences({ searchEngine: 'google' }).searchEngine, 'google')
  assert.equal(normalizeBrowserPreferences({ searchEngine: 'baidu' }).searchEngine, 'baidu')
})
