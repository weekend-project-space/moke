import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'

import type { SessionSummary } from '../model/conversation'
import { useSessionNavigation } from './useSessionNavigation'

test('new chat starts a local draft and writes the empty session route', async () => {
  const writtenSessionIds: string[] = []
  const sessionId = ref('sess_old')
  let starts = 0
  const navigation = useSessionNavigation({
    archiveSession: async () => true,
    clearQueuedMessages: () => undefined,
    closeTransientPanels: () => undefined,
    forkSession: async () => true,
    readSessionId: () => sessionId.value,
    selectAgentSession: async () => true,
    sessionId,
    startAgentSession: () => {
      starts += 1
      sessionId.value = ''
      return true
    },
    sortedSessions: ref([]),
    writeSessionId: (id) => { writtenSessionIds.push(id) },
  })

  assert.equal(await navigation.startNewSession(), true)
  assert.equal(starts, 1)
  assert.deepEqual(writtenSessionIds, [''])
})

test('failed persisted session selection does not change the route', async () => {
  const writtenSessionIds: string[] = []
  const navigation = useSessionNavigation({
    archiveSession: async () => true,
    clearQueuedMessages: () => undefined,
    closeTransientPanels: () => undefined,
    forkSession: async () => true,
    readSessionId: () => '',
    selectAgentSession: async () => false,
    sessionId: ref(''),
    startAgentSession: () => true,
    sortedSessions: ref([]),
    writeSessionId: (id) => { writtenSessionIds.push(id) },
  })

  assert.equal(await navigation.selectSession('sess_missing'), false)
  assert.deepEqual(writtenSessionIds, [])
})

test('empty and missing session routes start without selecting the first session', () => {
  const sortedSessions = ref<SessionSummary[]>([{
    id: 'sess_first',
    title: 'First session',
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    archived: false,
    pinned: false,
    preview: '',
    message_count: 0,
  }])
  const navigation = useSessionNavigation({
    archiveSession: async () => true,
    clearQueuedMessages: () => undefined,
    closeTransientPanels: () => undefined,
    forkSession: async () => true,
    readSessionId: () => '',
    selectAgentSession: async () => true,
    sessionId: ref(''),
    startAgentSession: () => true,
    sortedSessions,
    writeSessionId: () => undefined,
  })

  assert.equal(navigation.initialSession(), undefined)

  const missingNavigation = useSessionNavigation({
    archiveSession: async () => true,
    clearQueuedMessages: () => undefined,
    closeTransientPanels: () => undefined,
    forkSession: async () => true,
    readSessionId: () => 'sess_missing',
    selectAgentSession: async () => true,
    sessionId: ref(''),
    startAgentSession: () => true,
    sortedSessions,
    writeSessionId: () => undefined,
  })

  assert.equal(missingNavigation.initialSession(), undefined)
})
