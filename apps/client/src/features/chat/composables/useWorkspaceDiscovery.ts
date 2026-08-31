import { ref, watch, onBeforeUnmount, type ComputedRef, type Ref } from 'vue'
import type { SkillSummary, WorkspaceContext, WorkspaceEntry } from '@moke/agent-sdk'
import { createAgentApi } from '../api/agentApi'

type WorkspaceDiscoveryOptions = {
  apiBase: string
  input: Ref<string>
  sessionId: Ref<string>
  currentWorkspaceRoot: ComputedRef<string>
  getDraftWorkspaceRoot: () => string | undefined
}

export function useWorkspaceDiscovery({
  apiBase,
  input,
  sessionId,
  currentWorkspaceRoot,
  getDraftWorkspaceRoot,
}: WorkspaceDiscoveryOptions) {
  const workspaceEntries = ref<WorkspaceEntry[]>([])
  const workspaceSkills = ref<SkillSummary[]>([])
  const discoveryApi = createAgentApi(apiBase)
  const draftWorkspaceContext = ref<WorkspaceContext | null>(null)
  let discoveryTimer: number | undefined
  let discoveryRequestVersion = 0

  async function discoveryContext() {
    if (sessionId.value) return { sessionId: sessionId.value }
    const root = getDraftWorkspaceRoot()
    if (!root) return null
    const current = draftWorkspaceContext.value
    if (current?.root === root && (!current.expiresAt || Date.parse(current.expiresAt) > Date.now())) {
      return { contextId: current.id }
    }
    const context = await discoveryApi.workspace.createContext({ workspaceRoot: root })
    if (getDraftWorkspaceRoot() !== root || sessionId.value) return null
    draftWorkspaceContext.value = context
    return { contextId: context.id }
  }

  function clearDiscovery() {
    if (discoveryTimer) window.clearTimeout(discoveryTimer)
    discoveryTimer = undefined
    discoveryRequestVersion += 1
    workspaceEntries.value = []
    workspaceSkills.value = []
  }

  watch([sessionId, currentWorkspaceRoot], () => {
    draftWorkspaceContext.value = null
    clearDiscovery()
  })

  watch([input, sessionId, currentWorkspaceRoot], () => {
    clearDiscovery()
    const requestVersion = discoveryRequestVersion
    const match = input.value.match(/(?:^|\s)([@/])([^\s]*)$/)
    if (!match || !currentWorkspaceRoot.value) return
    discoveryTimer = window.setTimeout(async () => {
      discoveryTimer = undefined
      try {
        const context = await discoveryContext()
        if (!context || requestVersion !== discoveryRequestVersion) return
        if (match[1] === '@') {
          const entries = await discoveryApi.workspace.entries({
            ...context,
            query: match[2],
            includeDirectories: false,
          })
          if (requestVersion !== discoveryRequestVersion) return
          workspaceEntries.value = entries
        } else {
          const skills = await discoveryApi.skills.list({
            ...context,
            enabledOnly: true,
          })
          if (requestVersion !== discoveryRequestVersion) return
          workspaceSkills.value = skills
        }
      } catch {
        // Results were cleared before this request started.
      }
    }, 120)
  })

  onBeforeUnmount(() => {
    clearDiscovery()
  })

  return { workspaceEntries, workspaceSkills }
}
