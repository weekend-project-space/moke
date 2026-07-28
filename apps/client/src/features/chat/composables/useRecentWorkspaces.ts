import { ref } from 'vue'

const RECENT_WORKSPACES_KEY = 'moke.chat.recent-workspaces.v1'
const MAX_RECENT_WORKSPACES = 5

export type RecentWorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>

export function useRecentWorkspaces(storage = browserStorage()) {
  const stored = readStoredWorkspaces(storage)
  const recentWorkspaces = ref(stored.roots)
  let hasStoredValue = stored.found

  function persist() {
    if (!storage) return
    try {
      storage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(recentWorkspaces.value))
      hasStoredValue = true
    } catch {
      // Keep recent workspaces available for the current window.
    }
  }

  function rememberWorkspace(root: string) {
    const normalizedRoot = root.trim()
    if (!normalizedRoot) return
    recentWorkspaces.value = normalizeRecentWorkspaces([
      normalizedRoot,
      ...recentWorkspaces.value,
    ])
    persist()
  }

  function seedRecentWorkspaces(roots: string[]) {
    if (hasStoredValue || recentWorkspaces.value.length) return
    recentWorkspaces.value = normalizeRecentWorkspaces(roots)
    if (recentWorkspaces.value.length) persist()
  }

  return { recentWorkspaces, rememberWorkspace, seedRecentWorkspaces }
}

export function normalizeRecentWorkspaces(roots: unknown[]) {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const value of roots) {
    if (typeof value !== 'string') continue
    const root = value.trim()
    if (!root) continue
    const key = workspaceKey(root)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(root)
    if (normalized.length === MAX_RECENT_WORKSPACES) break
  }

  return normalized
}

function readStoredWorkspaces(storage: RecentWorkspaceStorage | undefined) {
  if (!storage) return { found: false, roots: [] as string[] }
  try {
    const raw = storage.getItem(RECENT_WORKSPACES_KEY)
    if (raw === null) return { found: false, roots: [] as string[] }
    const parsed: unknown = JSON.parse(raw)
    return {
      found: true,
      roots: Array.isArray(parsed) ? normalizeRecentWorkspaces(parsed) : [],
    }
  } catch {
    return { found: false, roots: [] as string[] }
  }
}

function browserStorage(): RecentWorkspaceStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function workspaceKey(root: string) {
  if (/^[a-z]:[\\/]/i.test(root) || /^\\\\/.test(root)) {
    return root.replaceAll('/', '\\').replace(/[\\]+$/, '').toLocaleLowerCase('en-US')
  }
  return root.replace(/\/+$/, '')
}
