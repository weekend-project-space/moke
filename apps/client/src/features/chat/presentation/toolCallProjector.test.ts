import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../model/conversation'
import { projectToolCalls, toolCallSummaryArguments } from './toolCallProjector'

function event<T extends AgentEvent['type']>(type: T, fields: Omit<Extract<AgentEvent, { type: T }>, 'eventId' | 'sequence' | 'threadId' | 'runId' | 'timestamp'>, sequence: number): Extract<AgentEvent, { type: T }> {
  return { ...fields, type, eventId: `evt_${sequence}`, sequence, threadId: 'thread_1', runId: 'run_1', timestamp: sequence } as Extract<AgentEvent, { type: T }>
}

test('projector accumulates split arguments and advances lifecycle status', () => {
  const events: AgentEvent[] = [
    event('tool_call.started', { toolCallId: 'call_1', toolCallName: 'execute' }, 1),
    event('tool_call.args', { toolCallId: 'call_1', delta: '{"command":"npm ' }, 2),
    event('tool_call.args', { toolCallId: 'call_1', delta: 'test"}' }, 3),
    event('tool_call.completed', { toolCallId: 'call_1' }, 4),
  ]
  const call = projectToolCalls(events).get('call_1')
  assert.equal(call?.status, 'executing')
  assert.equal(call?.argumentsText, '{"command":"npm test"}')
  assert.deepEqual(call?.arguments, { command: 'npm test' })
})

test('projector isolates parallel calls and accepts result without start', () => {
  const calls = projectToolCalls([
    event('tool_call.started', { toolCallId: 'a', toolCallName: 'read_file' }, 1),
    event('tool_call.started', { toolCallId: 'b', toolCallName: 'execute' }, 2),
    event('tool_call.args', { toolCallId: 'a', delta: '{"path":"a.ts"}' }, 3),
    event('tool_call.args', { toolCallId: 'b', delta: '{"command":"test"}' }, 4),
    event('tool_result.failed', { messageId: 'm', toolCallId: 'missing', toolName: 'write_file', content: 'failed', error: { kind: 'tool', code: 'FAILED', message: 'failed', retryable: false } }, 5),
  ])
  assert.deepEqual(calls.get('a')?.arguments, { path: 'a.ts' })
  assert.deepEqual(calls.get('b')?.arguments, { command: 'test' })
  assert.equal(calls.get('missing')?.status, 'failed')
})

test('projector keeps arguments private while parsing complete values', () => {
  projectToolCalls([
    event('tool_call.started', { toolCallId: 'a', toolCallName: 'request' }, 1),
    event('tool_call.args', { toolCallId: 'a', delta: '{"token":"secret-value' }, 2),
  ])

  const complete = projectToolCalls([
    event('tool_call.started', { toolCallId: 'b', toolCallName: 'request' }, 1),
    event('tool_call.args', { toolCallId: 'b', delta: '{"nested":{"password":"secret"},"value":"ok"}' }, 2),
  ]).get('b')!
  assert.deepEqual(complete?.arguments, { nested: { password: 'secret' }, value: 'ok' })
})

test('summary arguments expose a file path before the full arguments are complete', () => {
  const call = projectToolCalls([
    event('tool_call.started', { toolCallId: 'call_1', toolCallName: 'write_file' }, 1),
    event('tool_call.args', { toolCallId: 'call_1', delta: '{"path":"src/app.ts","content":"still streaming' }, 2),
  ]).get('call_1')

  assert.deepEqual(toolCallSummaryArguments(call), { path: 'src/app.ts' })
})
