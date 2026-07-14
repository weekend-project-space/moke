import type { Ref } from 'vue'

import type { SessionSummary } from '../model/conversation'
import { readSessionIdFromHash, writeSessionIdToHash } from '../services/sessionRoute'

type UseSessionNavigationOptions = {
  appView: Ref<'chat' | 'settings'>
  archiveSession: (id: string) => Promise<boolean>
  canLeaveSettings: () => boolean
  clearQueuedMessages: () => void
  closeTransientPanels: () => void
  createSession: () => Promise<boolean>
  forkSession: (messageId: string) => Promise<boolean>
  onCloseSettings: () => void
  selectAgentSession: (id: string) => Promise<boolean>
  sessionId: Ref<string>
  sortedSessions: Readonly<Ref<SessionSummary[]>>
}

export function useSessionNavigation(options: UseSessionNavigationOptions) {
  function canEnterChat() {
    return options.appView.value !== 'settings' || options.canLeaveSettings()
  }

  function initialSessionFromHash() {
    const hashSessionId = readSessionIdFromHash()
    if (!hashSessionId) return options.sortedSessions.value[0]
    return options.sortedSessions.value.find((session) => session.id === hashSessionId)
      || options.sortedSessions.value[0]
  }

  async function selectSession(id: string) {
    if (!canEnterChat()) return false
    if (!(await options.selectAgentSession(id))) return false

    options.clearQueuedMessages()
    options.appView.value = 'chat'
    writeSessionIdToHash(id)
    options.closeTransientPanels()
    return true
  }

  async function startNewSession() {
    if (!canEnterChat()) return false
    if (!(await options.createSession())) return false

    options.clearQueuedMessages()
    options.appView.value = 'chat'
    writeSessionIdToHash(options.sessionId.value)
    options.closeTransientPanels()
    return true
  }

  async function forkMessage(messageId: string) {
    if (!canEnterChat()) return false
    if (!(await options.forkSession(messageId))) return false

    options.clearQueuedMessages()
    options.appView.value = 'chat'
    writeSessionIdToHash(options.sessionId.value)
    options.closeTransientPanels()
    return true
  }

  async function archiveSelectedSession(id: string) {
    if (!(await options.archiveSession(id))) return false
    writeSessionIdToHash(options.sessionId.value)
    return true
  }

  function openSettings() {
    options.appView.value = 'settings'
    options.closeTransientPanels()
  }

  function closeSettings() {
    if (!canEnterChat()) return false
    options.appView.value = 'chat'
    options.onCloseSettings()
    return true
  }

  return {
    archiveSelectedSession,
    closeSettings,
    forkMessage,
    initialSessionFromHash,
    openSettings,
    selectSession,
    startNewSession,
  }
}
