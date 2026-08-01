import type { Ref } from 'vue'

import type { SessionSummary } from '../model/conversation'
import { readSessionIdFromHash, writeSessionIdToHash } from '../services/sessionRoute'

type UseSessionNavigationOptions = {
  archiveSession: (id: string) => Promise<boolean>
  clearQueuedMessages: () => void
  closeTransientPanels: () => void
  forkSession: (messageId: string) => Promise<boolean>
  selectAgentSession: (id: string) => Promise<boolean>
  sessionId: Ref<string>
  startAgentSession: () => boolean
  sortedSessions: Readonly<Ref<SessionSummary[]>>
}

export function useSessionNavigation(options: UseSessionNavigationOptions) {
  function initialSessionFromHash() {
    const hashSessionId = readSessionIdFromHash()
    if (!hashSessionId) return options.sortedSessions.value[0]
    return options.sortedSessions.value.find((session) => session.id === hashSessionId)
      || options.sortedSessions.value[0]
  }

  async function selectSession(id: string) {
    if (!(await options.selectAgentSession(id))) return false

    options.clearQueuedMessages()
    writeSessionIdToHash(id)
    options.closeTransientPanels()
    return true
  }

  async function startNewSession() {
    if (!options.startAgentSession()) return false

    options.clearQueuedMessages()
    writeSessionIdToHash('')
    options.closeTransientPanels()
    return true
  }

  async function forkMessage(messageId: string) {
    if (!(await options.forkSession(messageId))) return false

    options.clearQueuedMessages()
    writeSessionIdToHash(options.sessionId.value)
    options.closeTransientPanels()
    return true
  }

  async function archiveSelectedSession(id: string) {
    if (!(await options.archiveSession(id))) return false
    writeSessionIdToHash(options.sessionId.value)
    return true
  }

  return {
    archiveSelectedSession,
    forkMessage,
    initialSessionFromHash,
    selectSession,
    startNewSession,
  }
}
