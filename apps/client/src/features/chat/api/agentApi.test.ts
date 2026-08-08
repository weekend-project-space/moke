import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentApiError, createAgentApi } from './agentApi'

test('agentApi creates a session with its immutable workspace environment', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ session: { id: 'session_1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  const api = createAgentApi('http://localhost:4010', fetcher)

  assert.equal(await api.createSession('Project A', {
    approval_mode: 'manual',
    workspace: { root: 'E:\\work\\project-a' },
  }), 'session_1')

  assert.equal(calls[0]?.url, 'http://localhost:4010/api/sessions')
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    title: 'Project A',
    env: {
      approval_mode: 'manual',
      workspace: { root: 'E:\\work\\project-a' },
    },
  })
})

test('agentApi sends a typed message request and returns the SDK RunHandle', async () => {
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
    env: { reasoningEffort: 'high' },
  })

  assert.equal(run.id, 'run_1')
  assert.equal(run.sessionId, 'session_1')
  assert.equal(calls[0]?.url, 'http://localhost:4010/api/sessions/session_1/messages')
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    message: { role: 'user', content: 'hello' },
    env: { reasoningEffort: 'high' },
    options: { stream: true },
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

test('agentApi updates the mutable session approval environment', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ session: { id: 'session_1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  const api = createAgentApi('http://localhost:4010', fetcher)

  await api.updateSessionEnvironment('session_1', { approval_mode: 'ai_review' })

  assert.equal(calls[0]?.url, 'http://localhost:4010/api/sessions/session_1/env')
  assert.equal(calls[0]?.init?.method, 'PATCH')
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    approval_mode: 'ai_review',
  })
})

test('agentApi exposes composer discovery through the SDK resources', async () => {
  const calls: string[] = []
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = String(input)
    calls.push(url)
    const body = url.includes('/workspace/entries')
      ? [{ name: 'README.md', path: '/workspace/README.md' }]
      : [{ name: 'research', description: 'Research sources' }]
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  const api = createAgentApi('http://localhost:4010', fetcher)

  assert.deepEqual(await api.workspace.entries({ sessionId: 'session_1', query: 'read', includeDirectories: false }), [
    { name: 'README.md', path: '/workspace/README.md' },
  ])
  assert.deepEqual(await api.skills.list({ sessionId: 'session_1', enabledOnly: true }), [
    { name: 'research', description: 'Research sources' },
  ])
  assert.match(calls[0] || '', /session_id=session_1/)
  assert.match(calls[0] || '', /include_directories=false/)
  assert.match(calls[1] || '', /enabled_only=true/)
})

test('agentApi creates a draft workspace context before a session exists', async () => {
  let requestBody: unknown
  const api = createAgentApi('http://localhost:4010', (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'context_1',
      root: 'E:\\work\\draft',
      expires_at: '2026-08-08T01:00:00.000Z',
    }), { status: 201 })
  }) as typeof fetch)

  assert.deepEqual(await api.workspace.createContext({ workspaceRoot: 'E:\\work\\draft' }), {
    id: 'context_1',
    root: 'E:\\work\\draft',
    expiresAt: '2026-08-08T01:00:00.000Z',
  })
  assert.deepEqual(requestBody, { root: 'E:\\work\\draft' })
})
