import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeRecentWorkspaces, type RecentWorkspaceStorage, useRecentWorkspaces } from './useRecentWorkspaces'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set('moke.chat.recent-workspaces.v1', initial)
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    } satisfies RecentWorkspaceStorage,
    values,
  }
}

test('recent workspaces deduplicate Windows paths and keep five entries', () => {
  assert.deepEqual(normalizeRecentWorkspaces([
    'E:\\Work\\Moke\\',
    'e:/work/moke',
    '/work/a',
    '/work/b',
    '/work/c',
    '/work/d',
    '/work/e',
  ]), [
    'E:\\Work\\Moke\\',
    '/work/a',
    '/work/b',
    '/work/c',
    '/work/d',
  ])
})

test('remembering a workspace persists it independently and moves it to the front', () => {
  const { storage, values } = memoryStorage(JSON.stringify(['E:\\work\\a', 'E:\\work\\b']))
  const recent = useRecentWorkspaces(storage)

  recent.rememberWorkspace('e:/work/b')

  assert.deepEqual(recent.recentWorkspaces.value, ['e:/work/b', 'E:\\work\\a'])
  assert.equal(values.get('moke.chat.recent-workspaces.v1'), JSON.stringify(['e:/work/b', 'E:\\work\\a']))
})

test('existing session workspaces seed storage only when no recent value exists', () => {
  const empty = memoryStorage()
  const recent = useRecentWorkspaces(empty.storage)
  recent.seedRecentWorkspaces(['E:\\work\\latest', 'E:\\work\\older'])
  assert.deepEqual(recent.recentWorkspaces.value, ['E:\\work\\latest', 'E:\\work\\older'])

  const stored = memoryStorage(JSON.stringify(['E:\\work\\saved']))
  const existing = useRecentWorkspaces(stored.storage)
  existing.seedRecentWorkspaces(['E:\\work\\session'])
  assert.deepEqual(existing.recentWorkspaces.value, ['E:\\work\\saved'])
})
