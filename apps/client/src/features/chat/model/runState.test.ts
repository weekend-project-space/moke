import assert from 'node:assert/strict'
import test from 'node:test'

import {
  connectRun,
  createSessionRunState,
  finishRunState,
  isRunActive,
  pendingApprovalFrom,
  pendingAskFrom,
  startRun,
} from './runState'

test('runState models starting, running and idle as exclusive states', () => {
  const state = createSessionRunState()
  assert.equal(isRunActive(state), false)

  startRun(state)
  assert.deepEqual(state.lifecycle, { status: 'starting' })
  assert.equal(isRunActive(state), true)

  connectRun(state, 'run_1')
  assert.deepEqual(state.lifecycle, { status: 'running' })
  assert.equal(state.runId, 'run_1')

  finishRunState(state)
  assert.deepEqual(state.lifecycle, { status: 'idle' })
  assert.equal(pendingAskFrom(state), null)
  assert.equal(pendingApprovalFrom(state), null)
})

test('runState keeps pending data inside its matching lifecycle state', () => {
  const state = createSessionRunState()
  const ask = {
    ask_id: 'ask_1',
    call_id: 'call_1',
    question: 'Continue?',
    options: [{ id: 'yes', label: 'Yes' }],
    created_at: '2026-01-01T00:00:00.000Z',
  }

  connectRun(state, 'run_1', ask)
  assert.equal(pendingAskFrom(state), ask)
  assert.equal(pendingApprovalFrom(state), null)
})
