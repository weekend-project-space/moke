import type { SessionSummary } from '../model/conversation'

export const UNASSIGNED_PROJECT_KEY = '__unassigned__'

export type SessionProjectGroup = {
  key: string
  label: string
  root: string
  sessions: SessionSummary[]
}

function normalizedWorkspaceRoot(root: string) {
  const normalized = root.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return ''

  const isWindowsPath = /^[a-z]:\//i.test(normalized) || root.includes('\\')
  return isWindowsPath ? normalized.toLocaleLowerCase() : normalized
}

function projectLabel(root: string) {
  const normalized = root.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).at(-1) || root
}

export function groupSessionsByProject(
  sessions: SessionSummary[],
  unassignedLabel: string,
): SessionProjectGroup[] {
  const groups = new Map<string, SessionProjectGroup>()

  for (const session of sessions) {
    const root = session.env?.workspace.root?.trim() || ''
    const key = normalizedWorkspaceRoot(root) || UNASSIGNED_PROJECT_KEY
    const existing = groups.get(key)
    if (existing) {
      existing.sessions.push(session)
      continue
    }

    groups.set(key, {
      key,
      label: root ? projectLabel(root) : unassignedLabel,
      root,
      sessions: [session],
    })
  }

  return [...groups.values()]
}
