import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEvent } from './conversation'
import { reduceRunEvent } from './runEventReducer'
import { connectRun, createSessionRunState } from './runState'

function event<T extends AgentEvent['type']>(
  type: T,
  payload: Extract<AgentEvent, { type: T }>['payload'],
  id = `event_${type}`,
) {
  return {
    id,
    seq: 1,
    type,
    run_id: 'run_1',
    session_id: 'session_1',
    ts: '2026-01-01T00:00:00.000Z',
    payload,
  } as Extract<AgentEvent, { type: T }>
}

test('run event reducer deduplicates answer deltas without storing them', () => {
  const state = createSessionRunState('run_1')
  const delta = event('agent.message.delta', { channel: 'answer', content: 'hello' })

  const first = reduceRunEvent(state, delta)
  const duplicate = reduceRunEvent(first.state, delta)

  assert.equal(first.accepted, true)
  assert.equal(first.effects.answerDelta, 'hello')
  assert.deepEqual(first.state.events, [])
  assert.equal(state.seenEventKeys.size, 0)
  assert.equal(duplicate.accepted, false)
  assert.equal(duplicate.state, first.state)
})

test('run event reducer stores reasoning deltas and enters pending states', () => {
  const state = createSessionRunState('run_1')
  connectRun(state, 'run_1')
  const reasoning = event('agent.message.delta', { channel: 'reasoning', content: 'thinking' })
  const ask = {
    ask_id: 'ask_1',
    call_id: 'call_1',
    question: 'Continue?',
    options: [{ id: 'yes', label: 'Yes' }],
    created_at: '2026-01-01T00:00:00.000Z',
  }

  const afterReasoning = reduceRunEvent(state, reasoning)
  const afterAsk = reduceRunEvent(afterReasoning.state, event('ask_user.required', ask))
  const approval = {
    approval_id: 'approval_1',
    kind: 'tool' as const,
    reason: 'Write data',
    risk: 'write' as const,
    action: { tool: 'write_file', input: {} },
    created_at: '2026-01-01T00:00:00.000Z',
  }
  const afterApproval = reduceRunEvent(afterAsk.state, event('approval.required', approval))

  assert.equal(afterReasoning.state.events.length, 1)
  assert.deepEqual(afterAsk.state.lifecycle, { status: 'awaiting-user', ask })
  assert.equal(afterAsk.effects.ask, ask)
  assert.equal(afterAsk.state.events.length, 1)
  assert.deepEqual(afterApproval.state.lifecycle, { status: 'awaiting-approval', approval })
  assert.equal(afterApproval.state.events.length, 1)
})

test('run event reducer exposes completed messages and finishes terminal runs', () => {
  const state = createSessionRunState('run_1')
  connectRun(state, 'run_1')
  const message = {
    id: 'message_1',
    role: 'assistant' as const,
    content: 'done',
    created_at: '2026-01-01T00:00:00.000Z',
  }

  const afterMessage = reduceRunEvent(state, event('agent.message.done', { message }))
  const afterDone = reduceRunEvent(afterMessage.state, event('agent.done', { status: 'completed' }))

  assert.equal(afterMessage.effects.message, message)
  assert.deepEqual(afterMessage.state.events, [])
  assert.equal(afterDone.effects.finish, true)
  assert.deepEqual(afterDone.state.events, [])
  assert.deepEqual(afterDone.state.lifecycle, { status: 'idle' })
  assert.equal(afterDone.state.connection, 'disconnected')
})
