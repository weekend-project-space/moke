import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'

import { useSessionNavigation } from './useSessionNavigation'

function installWindow(hash = '#session=sess_old') {
  const writtenUrls: string[] = []
  const location = { pathname: '/chat', search: '', hash }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          writtenUrls.push(url)
          const hashIndex = url.indexOf('#')
          location.hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
        },
      },
    },
  })
  return writtenUrls
}

test('new chat starts a local draft and clears the persisted session hash', async () => {
  const writtenUrls = installWindow()
  const sessionId = ref('sess_old')
  let starts = 0
  const navigation = useSessionNavigation({
    archiveSession: async () => true,
    clearQueuedMessages: () => undefined,
    closeTransientPanels: () => undefined,
    forkSession: async () => true,
    selectAgentSession: async () => true,
    sessionId,
    startAgentSession: () => {
      starts += 1
      sessionId.value = ''
      return true
    },
    sortedSessions: ref([]),
  })

  assert.equal(await navigation.startNewSession(), true)
  assert.equal(starts, 1)
  assert.deepEqual(writtenUrls, ['/chat'])
})

test('failed persisted session selection does not change the hash', async () => {
  const writtenUrls = installWindow('')
  const navigation = useSessionNavigation({
    archiveSession: async () => true,
    clearQueuedMessages: () => undefined,
    closeTransientPanels: () => undefined,
    forkSession: async () => true,
    selectAgentSession: async () => false,
    sessionId: ref(''),
    startAgentSession: () => true,
    sortedSessions: ref([]),
  })

  assert.equal(await navigation.selectSession('sess_missing'), false)
  assert.deepEqual(writtenUrls, [])
})
