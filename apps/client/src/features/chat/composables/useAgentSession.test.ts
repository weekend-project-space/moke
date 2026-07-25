import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunHandle, RunLifecycleEvent, RunLifecycleListener } from '@moke/agent-sdk'
import type { AgentApi } from '../api/agentApi'
import type { Message } from '../model/conversation'
import { useAgentSession } from './useAgentSession'

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: globalThis,
})

function createHarness(initialMessages: Message[]) {
  let lifecycleListener: RunLifecycleListener | undefined
  let loadedMessages = initialMessages
  let loadCount = 0
  let resolveSend: ((run: RunHandle) => void) | undefined
  let sendPromise: Promise<RunHandle> | undefined

  const api = {
    checkHealth: async () => true,
    loadSessionMessages: async () => {
      loadCount += 1
      return loadedMessages
    },
    onRunLifecycle: (listener: RunLifecycleListener) => {
      lifecycleListener = listener
      return () => undefined
    },
    onSessionRunEvent: () => () => undefined,
    sendMessage: () => {
      if (!sendPromise) {
        sendPromise = new Promise<RunHandle>((resolve) => {
          resolveSend = resolve
        })
      }
      return sendPromise
    },
  } as unknown as AgentApi

  const session = useAgentSession({
    apiBase: '',
    api,
    isFinalAssistantMessage: () => false,
  })

  return {
    session,
    emitLifecycle(event: RunLifecycleEvent) {
      assert.ok(lifecycleListener)
      lifecycleListener(event)
    },
    get loadCount() {
      return loadCount
    },
    resolveSend(runId: string) {
      assert.ok(resolveSend)
      resolveSend({ id: runId } as RunHandle)
    },
    setLoadedMessages(messages: Message[]) {
      loadedMessages = messages
    },
  }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

test('current session loads an external user message when a new run appears', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  await harness.session.loadSessionMessages('sess_external')
  harness.setLoadedMessages([{ id: 'msg_external', role: 'user', content: 'from DingTalk' }])

  harness.emitLifecycle({ type: 'running', sessionId: 'sess_external', runId: 'run_external' })
  await flushPromises()

  assert.equal(harness.loadCount, 2)
  assert.deepEqual(harness.session.messages.value, [
    { id: 'msg_external', role: 'user', content: 'from DingTalk' },
  ])
  harness.session.disposeAgentSession()
})

test('local lifecycle does not reload messages when it arrives before send response', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  await harness.session.loadSessionMessages('sess_local')

  const sending = harness.session.sendMessage('local message')
  harness.emitLifecycle({ type: 'running', sessionId: 'sess_local', runId: 'run_local' })
  await flushPromises()

  assert.equal(harness.loadCount, 1)
  harness.resolveSend('run_local')
  assert.equal(await sending, true)
  assert.equal(harness.session.messages.value.length, 1)
  assert.equal(harness.session.messages.value[0]?.content, 'local message')
  harness.session.disposeAgentSession()
})

test('local lifecycle does not reload messages when it arrives after send response', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  await harness.session.loadSessionMessages('sess_local')

  const sending = harness.session.sendMessage('local message')
  harness.resolveSend('run_local')
  assert.equal(await sending, true)
  harness.emitLifecycle({ type: 'running', sessionId: 'sess_local', runId: 'run_local' })
  await flushPromises()

  assert.equal(harness.loadCount, 1)
  assert.equal(harness.session.messages.value.length, 1)
  harness.session.disposeAgentSession()
})
