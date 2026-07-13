import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEvent } from '../model/conversation'
import { createRunEventStream, type EventSourceConnection } from './runEventStream'

class FakeEventSource implements EventSourceConnection {
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close() {
    this.closed = true
  }

  emit(event: AgentEvent) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener({ data: JSON.stringify(event) })
    }
  }
}

test('runEventStream reconnects with backoff and stops cleanly', () => {
  const sources: FakeEventSource[] = []
  const timers = new Map<number, () => void>()
  const delays: number[] = []
  const events: AgentEvent[] = []
  let activityCount = 0
  let reconnecting = 0
  let nextTimer = 0
  const stream = createRunEventStream({
    apiBase: 'http://localhost:4010',
    createEventSource: (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
    setTimer: (callback, delay) => {
      const id = ++nextTimer
      timers.set(id, callback)
      delays.push(delay)
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    onEvent: (_sessionId, event) => events.push(event),
    onActivity: () => activityCount++,
    onReconnecting: () => reconnecting++,
  })

  stream.subscribe('session_1', '/api/runs/run_1/events')
  assert.equal(sources[0]?.url, 'http://localhost:4010/api/runs/run_1/events')

  sources[0]?.emit({
    id: 'event_state',
    seq: 1,
    type: 'agent.state',
    run_id: 'run_1',
    session_id: 'session_1',
    ts: '2026-01-01T00:00:00.000Z',
    payload: { state: 'reason' },
  })
  assert.equal(activityCount, 1)
  assert.deepEqual(events, [])

  const event: AgentEvent = {
    id: 'event_1',
    seq: 2,
    type: 'agent.message.delta',
    run_id: 'run_1',
    session_id: 'session_1',
    ts: '2026-01-01T00:00:00.000Z',
    payload: { channel: 'answer', content: 'hello' },
  }
  sources[0]?.emit(event)
  assert.equal(activityCount, 2)
  assert.deepEqual(events, [event])

  sources[0]?.onerror?.()
  assert.equal(sources[0]?.closed, true)
  assert.equal(reconnecting, 1)
  assert.deepEqual(delays, [500])

  timers.get(1)?.()
  assert.equal(sources.length, 2)
  stream.close('session_1')
  assert.equal(sources[1]?.closed, true)
})

test('runEventStream cancels a scheduled reconnect when closed', () => {
  const sources: FakeEventSource[] = []
  const timers = new Map<number, () => void>()
  const stream = createRunEventStream({
    apiBase: '',
    createEventSource: (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
    setTimer: (callback) => {
      timers.set(1, callback)
      return 1
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    onEvent: () => undefined,
  })

  stream.subscribe('session_1', '/events')
  sources[0]?.onerror?.()
  assert.equal(timers.size, 1)

  stream.close('session_1')
  assert.equal(timers.size, 0)
})
