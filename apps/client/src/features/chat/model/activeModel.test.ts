import assert from 'node:assert/strict'
import test from 'node:test'

import { activeModelFromSettings } from './activeModel'

test('activeModelFromSettings selects the active provider', () => {
  assert.deepEqual(activeModelFromSettings({
    activeProviderId: 'provider_2',
    providers: [
      { id: 'provider_1', name: 'Local', model: 'qwen-local' },
      { id: 'provider_2', name: 'Cloud', model: 'gpt-test' },
    ],
  }), {
    model: 'gpt-test',
    providerId: 'provider_2',
    providerName: 'Cloud',
  })
})

test('activeModelFromSettings rejects missing model data', () => {
  assert.equal(activeModelFromSettings(null), null)
  assert.equal(activeModelFromSettings({ providers: [{ id: 'provider_1', model: '' }] }), null)
})
