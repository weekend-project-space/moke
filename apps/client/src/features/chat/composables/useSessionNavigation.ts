import type { Ref } from 'vue'

import type { SessionSummary } from '../model/conversation'
import { readSessionIdFromHash, writeSessionIdToHash } from '../services/sessionRoute'

type UseSessionNavigationOptions = {
  archiveSession: (id: string) => Promise<boolean>
  clearQueuedMessages: () => void
  closeTransientPanels: () => void
  createSession: () => Promise<boolean>
  forkSession: (messageId: string) => Promise<boolean>
  onCloseSettings: () => void
  resetConversationScroll: () => void
  selectAgentSession: (id: string) => Promise<boolean>
  sessionId: Ref<string>
  showSettings: Ref<boolean>
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
    options.resetConversationScroll()
    if (!(await options.selectAgentSession(id))) return false

    options.clearQueuedMessages()
    options.showSettings.value = false
    writeSessionIdToHash(id)
    options.closeTransientPanels()
    return true
  }

  async function startNewSession() {
    if (!(await options.createSession())) return false

    options.clearQueuedMessages()
    options.showSettings.value = false
    writeSessionIdToHash(options.sessionId.value)
    options.closeTransientPanels()
    return true
  }

  async function forkMessage(messageId: string) {
    options.resetConversationScroll()
    if (!(await options.forkSession(messageId))) return false

    options.clearQueuedMessages()
    options.showSettings.value = false
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
    options.showSettings.value = true
    options.closeTransientPanels()
  }

  function closeSettings() {
    options.showSettings.value = false
    options.onCloseSettings()
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
