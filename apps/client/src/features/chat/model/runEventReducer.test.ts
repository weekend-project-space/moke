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
    action: { tool: 'write_file', input: {} },
    created_at: '2026-01-01T00:00:00.000Z',
  }
  const afterApproval = reduceRunEvent(afterAsk.state, event('approval.required', approval))

  assert.equal(afterReasoning.state.events.length, 1)
  assert.deepEqual(afterAsk.state.lifecycle, { status: 'awaiting-user', ask })
  assert.equal(afterAsk.state.events.length, 1)
  assert.deepEqual(afterApproval.state.lifecycle, { status: 'awaiting-approval', approval })
  assert.equal(afterApproval.state.events.length, 1)
})

test('run event reducer stores tool lifecycle events in order', () => {
  const state = createSessionRunState('run_1')
  const created = event('tool.call.created', {
    call_id: 'call_1',
    tool: 'execute',
    source: { type: 'local' },
  }, 'event_tool_created')
  const ready = event('tool.call.ready', {
    call_id: 'call_1',
    input: { command: 'npm test' },
  }, 'event_tool_ready')
  const completed = event('tool.call.completed', {
    call_id: 'call_1',
    status: 'ok',
    duration_ms: 42,
    output: { exit_code: 0 },
  }, 'event_tool_completed')

  const afterCreated = reduceRunEvent(state, created)
  const afterReady = reduceRunEvent(afterCreated.state, ready)
  const afterCompleted = reduceRunEvent(afterReady.state, completed)

  assert.deepEqual(afterCompleted.state.events, [created, ready, completed])
})

test('run event reducer rebuilds completed interactions from replayed events', () => {
  const state = createSessionRunState('run_1')
  connectRun(state, 'run_1')
  const ask = {
    ask_id: 'ask_1',
    call_id: 'call_1',
    question: 'Continue?',
    options: [{ id: 'yes', label: 'Yes' }],
    created_at: '2026-01-01T00:00:00.000Z',
  }
  const approval = {
    approval_id: 'approval_1',
    kind: 'tool' as const,
    reason: 'Run command',
    action: { tool: 'execute', input: { command: 'npm test' } },
    created_at: '2026-01-01T00:00:00.000Z',
  }

  const afterAsk = reduceRunEvent(state, event('ask_user.required', ask, 'event_ask_required'))
  const afterAnswer = reduceRunEvent(afterAsk.state, event('ask_user.answered', {
    ask_id: ask.ask_id,
    call_id: ask.call_id,
    selected: ask.options[0],
  }, 'event_ask_answered'))
  const afterApproval = reduceRunEvent(afterAnswer.state, event('approval.required', approval, 'event_approval_required'))
  const afterResolution = reduceRunEvent(afterApproval.state, event('approval.resolved', {
    approval_id: approval.approval_id,
    decision: 'approved',
    scope: 'once',
  }, 'event_approval_resolved'))

  assert.deepEqual(afterAnswer.state.lifecycle, { status: 'running' })
  assert.deepEqual(afterResolution.state.lifecycle, { status: 'running' })
})

test('run event reducer does not resolve a newer interaction with an older completion event', () => {
  const state = createSessionRunState('run_1')
  const ask = {
    ask_id: 'ask_new',
    call_id: 'call_new',
    question: 'New question?',
    options: [{ id: 'yes', label: 'Yes' }],
    created_at: '2026-01-01T00:00:00.000Z',
  }
  const afterAsk = reduceRunEvent(state, event('ask_user.required', ask, 'event_ask_new'))
  const afterOldAnswer = reduceRunEvent(afterAsk.state, event('ask_user.answered', {
    ask_id: 'ask_old',
    call_id: 'call_old',
    selected: { id: 'yes', label: 'Yes' },
  }, 'event_ask_old_answered'))

  assert.deepEqual(afterOldAnswer.state.lifecycle, { status: 'awaiting-user', ask })
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
