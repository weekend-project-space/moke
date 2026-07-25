import { computed, ref } from 'vue'

import type { AgentApi } from '../api/agentApi'
import type { SessionSummary } from '../model/conversation'

export function useSessionCatalog(options: {
  api: AgentApi
  isOnline: () => boolean
  ensureOnline: () => Promise<boolean>
  isSessionRunning: (id: string) => boolean
}) {
  const sessions = ref<SessionSummary[]>([])
  const sortedSessions = computed(() => [...sessions.value].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return Date.parse(right.updated_at) - Date.parse(left.updated_at)
  }))

  async function loadSessions() {
    if (!options.isOnline()) return
    try {
      sessions.value = await options.api.listSessions()
    } catch {
      // Keep the last successful list during transient failures.
    }
  }

  async function updateSession(
    id: string,
    payload: Record<string, unknown>,
    optionsOverride: { allowWhileRunning?: boolean } = {},
  ) {
    if (!id || (!optionsOverride.allowWhileRunning && options.isSessionRunning(id))) return false
    if (!options.isOnline() && !(await options.ensureOnline())) return false
    try {
      await options.api.updateSession(id, payload)
    } catch {
      return false
    }
    await loadSessions()
    return true
  }

  function renameSession(id: string, title: string) {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return Promise.resolve(false)
    return updateSession(id, { title: trimmedTitle })
  }

  function pinSession(id: string, pinned: boolean) {
    if (!id) return Promise.resolve(false)
    return updateSession(id, { pinned }, { allowWhileRunning: true })
  }

  return { sessions, sortedSessions, loadSessions, updateSession, renameSession, pinSession }
}
