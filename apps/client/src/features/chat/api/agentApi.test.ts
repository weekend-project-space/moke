import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentApiError, createAgentApi } from './agentApi'

test('agentApi sends a typed message request and normalizes the run response', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ run_id: 'run_1', session_id: 'session_1', events_url: '/events/1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  const api = createAgentApi('http://localhost:4010', fetcher)

  const run = await api.sendMessage('session_1', {
    content: 'hello',
    attachments: [],
    reasoningEffort: 'high',
  })

  assert.deepEqual(run, { runId: 'run_1', eventsUrl: '/api/runs/run_1/events' })
  assert.equal(calls[0]?.url, 'http://localhost:4010/api/sessions/session_1/messages')
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    message: { role: 'user', content: 'hello' },
    options: { stream: true, reasoningEffort: 'high' },
  })
})

test('agentApi reports non-success responses consistently', async () => {
  const fetcher = (async () => new Response(JSON.stringify({
    error: { code: 'ASK_NOT_PENDING', message: 'Run is not waiting for this answer' },
  }), { status: 409 })) as typeof fetch
  const api = createAgentApi('', fetcher)

  await assert.rejects(
    api.listSessions(),
    (error: unknown) => error instanceof AgentApiError
      && error.status === 409
      && error.code === 'ASK_NOT_PENDING'
      && error.message === 'Run is not waiting for this answer',
  )
})
