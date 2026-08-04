import type { Ref } from 'vue'

import type { SessionSummary } from '../model/conversation'

type UseSessionNavigationOptions = {
  archiveSession: (id: string) => Promise<boolean>
  clearQueuedMessages: () => void
  closeTransientPanels: () => void
  forkSession: (messageId: string) => Promise<boolean>
  selectAgentSession: (id: string) => Promise<boolean>
  sessionId: Ref<string>
  startAgentSession: () => boolean
  sortedSessions: Readonly<Ref<SessionSummary[]>>
  readSessionId: () => string
  writeSessionId: (id: string, replace?: boolean) => void
}

export function useSessionNavigation(options: UseSessionNavigationOptions) {
  function initialSession() {
    const routeSessionId = options.readSessionId()
    if (!routeSessionId) return undefined
    return options.sortedSessions.value.find((session) => session.id === routeSessionId)
  }

  async function selectSession(id: string) {
    if (!(await options.selectAgentSession(id))) return false

    options.clearQueuedMessages()
    options.writeSessionId(id)
    options.closeTransientPanels()
    return true
  }

  async function startNewSession(replace = false) {
    if (!options.startAgentSession()) return false

    options.clearQueuedMessages()
    options.writeSessionId('', replace)
    options.closeTransientPanels()
    return true
  }

  async function forkMessage(messageId: string) {
    if (!(await options.forkSession(messageId))) return false

    options.clearQueuedMessages()
    options.writeSessionId(options.sessionId.value, true)
    options.closeTransientPanels()
    return true
  }

  async function archiveSelectedSession(id: string) {
    if (!(await options.archiveSession(id))) return false
    options.writeSessionId(options.sessionId.value, true)
    return true
  }

  return {
    archiveSelectedSession,
    forkMessage,
    initialSession,
    selectSession,
    startNewSession,
  }
}
