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
  readSessionId?: () => string
  writeSessionId?: (id: string, replace?: boolean) => void
}

export function useSessionNavigation(options: UseSessionNavigationOptions) {
  function initialSessionFromHash() {
    const hashSessionId = options.readSessionId ? options.readSessionId() : readSessionIdFromHash()
    if (!hashSessionId) return options.sortedSessions.value[0]
    return options.sortedSessions.value.find((session) => session.id === hashSessionId)
      || options.sortedSessions.value[0]
  }

  async function selectSession(id: string) {
    if (!(await options.selectAgentSession(id))) return false

    options.clearQueuedMessages()
    if (options.writeSessionId) options.writeSessionId(id)
    else writeSessionIdToHash(id)
    options.closeTransientPanels()
    return true
  }

  async function startNewSession() {
    if (!options.startAgentSession()) return false

    options.clearQueuedMessages()
    if (options.writeSessionId) options.writeSessionId('')
    else writeSessionIdToHash('')
    options.closeTransientPanels()
    return true
  }

  async function forkMessage(messageId: string) {
    if (!(await options.forkSession(messageId))) return false

    options.clearQueuedMessages()
    if (options.writeSessionId) options.writeSessionId(options.sessionId.value, true)
    else writeSessionIdToHash(options.sessionId.value)
    options.closeTransientPanels()
    return true
  }

  async function archiveSelectedSession(id: string) {
    if (!(await options.archiveSession(id))) return false
    if (options.writeSessionId) options.writeSessionId(options.sessionId.value)
    else writeSessionIdToHash(options.sessionId.value)
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
