import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from './conversation'
import { reduceRunEvent } from './runEventReducer'
import { connectRun, createSessionRunState } from './runState'

let sequence = 0
function event<T extends AgentEvent['type']>(type: T, fields: Omit<Extract<AgentEvent, { type: T }>, 'eventId' | 'sequence' | 'threadId' | 'runId' | 'timestamp'>): Extract<AgentEvent, { type: T }> {
  sequence += 1
  return { ...fields, eventId: `event_${sequence}`, sequence, threadId: 'session_1', runId: 'run_1', timestamp: Date.now(), type } as Extract<AgentEvent, { type: T }>
}

test('reducer deduplicates answer deltas and stores reasoning deltas', () => {
  const state = createSessionRunState('run_1')
  const delta = event('message.content', { messageId: 'msg_1', delta: 'hello' })
  const first = reduceRunEvent(state, delta)
  const duplicate = reduceRunEvent(first.state, delta)
  assert.equal(first.effects.answerDelta, 'hello')
  assert.equal(duplicate.accepted, false)
  const reasoning = event('reasoning_message.content', { messageId: 'msg_1', delta: 'thinking' })
  assert.equal(reduceRunEvent(first.state, reasoning).state.events.length, 1)
});

test('reducer tracks interactions and only resolves matching interaction', () => {
  const state = createSessionRunState('run_1'); connectRun(state, 'run_1')
  const required = event('interaction.required', { interaction: { id: 'ask_1', type: 'question', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }], allowText: true } })
  const waiting = reduceRunEvent(state, required)
  assert.equal(waiting.state.lifecycle.status, 'awaiting-user')
  const old = event('interaction.resolved', { interactionId: 'old', response: { interactionId: 'old', decision: 'answered', idempotencyKey: 'x' } })
  assert.equal(reduceRunEvent(waiting.state, old).state.lifecycle.status, 'awaiting-user')
  const resolved = event('interaction.resolved', { interactionId: 'ask_1', response: { interactionId: 'ask_1', decision: 'answered', idempotencyKey: 'y' } })
  assert.equal(reduceRunEvent(waiting.state, resolved).state.lifecycle.status, 'running')
});

test('reducer stores tool lifecycle and finishes terminal run', () => {
  const state = createSessionRunState('run_1')
  const started = event('tool_call.started', { toolCallId: 'call_1', toolCallName: 'execute' })
  const args = event('tool_call.args', { toolCallId: 'call_1', delta: '{"command":"npm test"}' })
  const result = event('tool_result.completed', { messageId: 'tool_msg', toolCallId: 'call_1', toolName: 'execute', content: 'ok', output: { exitCode: 0 } })
  const after = reduceRunEvent(reduceRunEvent(reduceRunEvent(state, started).state, args).state, result)
  assert.deepEqual(after.state.events.map(item => item.type), ['tool_call.started', 'tool_call.args', 'tool_result.completed'])
  const done = reduceRunEvent(after.state, event('run.completed', { result: undefined }))
  assert.equal(done.effects.finish, true)
  assert.equal(done.state.lifecycle.status, 'idle')
});
