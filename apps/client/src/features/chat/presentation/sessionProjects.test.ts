import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionSummary } from '../model/conversation'
import { groupSessionsByProject, UNASSIGNED_PROJECT_KEY } from './sessionProjects'

function session(id: string, root?: string): SessionSummary {
  return {
    id,
    title: id,
    visibility: 'visible',
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    archived: false,
    pinned: false,
    preview: '',
    message_count: 0,
    ...(root ? {
      env: {
        approval_mode: 'manual',
        system: { platform: 'windows', arch: 'x64', shell: 'pwsh' },
        workspace: { root },
      },
    } : {}),
  }
}

test('groups sessions by workspace while preserving their input order', () => {
  const sessions = [
    session('moke-latest', 'E:\\work\\moke'),
    session('notes', 'E:\\work\\notes'),
    session('moke-older', 'E:\\work\\moke'),
  ]

  const groups = groupSessionsByProject(sessions, 'No project')

  assert.deepEqual(groups.map((group) => group.label), ['moke', 'notes'])
  assert.deepEqual(groups[0]?.sessions.map((item) => item.id), ['moke-latest', 'moke-older'])
})

test('normalizes Windows separators, casing, and trailing slashes', () => {
  const groups = groupSessionsByProject([
    session('first', 'E:\\Work\\Moke\\'),
    session('second', 'e:/work/moke'),
  ], 'No project')

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.sessions.length, 2)
})

test('places sessions without a workspace in an unassigned group', () => {
  const groups = groupSessionsByProject([session('legacy')], 'No project')

  assert.equal(groups[0]?.key, UNASSIGNED_PROJECT_KEY)
  assert.equal(groups[0]?.label, 'No project')
  assert.equal(groups[0]?.root, '')
})
