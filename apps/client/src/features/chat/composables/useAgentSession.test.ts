import assert from 'node:assert/strict'
import test from 'node:test'
import type { CreateSessionEnvironmentInput, RunHandle, RunLifecycleEvent, RunLifecycleListener, SendMessageEnvironmentInput } from '@moke/agent-sdk'
import { uiText } from '../../../text/uiText'
import type { AgentApi } from '../api/agentApi'
import type { ImageAttachment, Message } from '../model/conversation'
import { useAgentSession } from './useAgentSession'

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: globalThis,
})

function createHarness(initialMessages: Message[]) {
  let lifecycleListener: RunLifecycleListener | undefined
  let loadedMessages = initialMessages
  let loadCount = 0
  let createError: Error | undefined
  const createCalls: Array<{ title: string; env?: CreateSessionEnvironmentInput }> = []
  const environmentUpdates: Array<{ id: string; approval_mode: string }> = []
  const createdSessionIds: string[] = []
  const sendCalls: Array<{
    sessionId: string
    input: {
      content: string
      attachments?: ImageAttachment[]
      env?: SendMessageEnvironmentInput
    }
  }> = []
  const pendingSends: Array<{
    resolve: (run: RunHandle) => void
    reject: (error: Error) => void
  }> = []

  const api = {
    checkHealth: async () => true,
    createSession: async (title: string, env?: CreateSessionEnvironmentInput) => {
      createCalls.push({ title, env })
      if (createError) throw createError
      return 'sess_created'
    },
    listSessions: async () => [],
    loadSessionMessages: async () => {
      loadCount += 1
      return loadedMessages
    },
    onRunLifecycle: (listener: RunLifecycleListener) => {
      lifecycleListener = listener
      return () => undefined
    },
    onSessionRunEvent: () => () => undefined,
    updateSessionEnvironment: async (id: string, input: { approval_mode: string }) => {
      environmentUpdates.push({ id, approval_mode: input.approval_mode })
    },
    sendMessage: (targetSessionId: string, input: {
      content: string
      attachments?: ImageAttachment[]
      env?: SendMessageEnvironmentInput
    }) => {
      sendCalls.push({ sessionId: targetSessionId, input })
      return new Promise<RunHandle>((resolve, reject) => {
        pendingSends.push({ resolve, reject })
      })
    },
  } as unknown as AgentApi

  const session = useAgentSession({
    apiBase: '',
    api,
    isFinalAssistantMessage: () => false,
    onSessionCreated: (id) => createdSessionIds.push(id),
  })

  return {
    session,
    createCalls,
    createdSessionIds,
    environmentUpdates,
    sendCalls,
    emitLifecycle(event: RunLifecycleEvent) {
      assert.ok(lifecycleListener)
      lifecycleListener(event)
    },
    get loadCount() {
      return loadCount
    },
    failCreate(error = new Error('create failed')) {
      createError = error
    },
    rejectSend(error = new Error('send failed')) {
      const pendingSend = pendingSends.shift()
      assert.ok(pendingSend)
      pendingSend.reject(error)
    },
    resolveSend(runId: string) {
      const pendingSend = pendingSends.shift()
      assert.ok(pendingSend)
      pendingSend.resolve({ id: runId } as RunHandle)
    },
    setLoadedMessages(messages: Message[]) {
      loadedMessages = messages
    },
  }
}

async function flushPromises() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
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

test('starting a new chat keeps a local draft and does not create an empty session', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()

  assert.equal(harness.session.startNewSession(), true)
  assert.equal(harness.session.sessionId.value, '')
  assert.deepEqual(harness.session.messages.value, [])
  assert.deepEqual(harness.createCalls, [])
  assert.deepEqual(harness.createdSessionIds, [])
  harness.session.disposeAgentSession()
})

test('first send creates one session with the draft workspace and approval mode', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  harness.session.startNewSession()
  harness.session.setDraftWorkspace('E:\\work\\project-a')
  await harness.session.setApprovalMode('ai_review')

  const sending = harness.session.sendMessage('first message')
  await flushPromises()

  assert.deepEqual(harness.createCalls, [{
    title: 'New chat',
    env: {
      approval_mode: 'ai_review',
      workspace: { root: 'E:\\work\\project-a' },
    },
  }])
  assert.equal(harness.session.sessionId.value, 'sess_created')
  assert.deepEqual(harness.createdSessionIds, ['sess_created'])

  harness.resolveSend('run_created')
  assert.equal(await sending, true)
  harness.session.disposeAgentSession()
})

test('repeated first send cannot create duplicate sessions', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  harness.session.startNewSession()

  const firstSend = harness.session.sendMessage('first message')
  const duplicateSend = harness.session.sendMessage('duplicate message')
  assert.equal(await duplicateSend, false)
  await flushPromises()
  assert.equal(harness.createCalls.length, 1)

  harness.resolveSend('run_created')
  assert.equal(await firstSend, true)
  harness.session.disposeAgentSession()
})

test('failed session creation preserves the new session draft', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  harness.session.startNewSession()
  harness.session.setDraftWorkspace('E:\\work\\project-b')
  await harness.session.setApprovalMode('auto_approve')
  harness.failCreate()

  assert.equal(await harness.session.sendMessage('retry me'), false)
  assert.equal(harness.session.sessionId.value, '')
  assert.deepEqual(harness.session.newSessionDraft, {
    approval_mode: 'auto_approve',
    workspace: { root: 'E:\\work\\project-b' },
  })
  assert.deepEqual(harness.createdSessionIds, [])
  assert.deepEqual(harness.sendCalls, [])
  assert.deepEqual(harness.session.submissionError.value, {
    code: 'SESSION_CREATE_FAILED',
    message: uiText.app.sessionCreateFailed,
  })
  assert.equal(harness.session.runError.value, uiText.app.sessionCreateFailed)
  harness.session.disposeAgentSession()
})

test('failed first message keeps the created session and retry reuses it', async () => {
  const harness = createHarness([])
  const attachment: ImageAttachment = {
    id: 'image_retry',
    kind: 'image',
    mime_type: 'image/png',
    data_url: 'data:image/png;base64,AA==',
  }
  await harness.session.checkServer()
  harness.session.startNewSession()

  const firstSend = harness.session.sendMessage({
    content: 'retry with attachment',
    attachments: [attachment],
  })
  await flushPromises()
  assert.equal(harness.session.messages.value.length, 1)
  harness.rejectSend()

  assert.equal(await firstSend, false)
  assert.equal(harness.session.sessionId.value, 'sess_created')
  assert.deepEqual(harness.createdSessionIds, ['sess_created'])
  assert.equal(harness.createCalls.length, 1)
  assert.equal(harness.sendCalls.length, 1)
  assert.equal(harness.sendCalls[0]?.sessionId, 'sess_created')
  assert.deepEqual(harness.sendCalls[0]?.input.attachments, [attachment])
  assert.deepEqual(harness.session.messages.value, [])
  assert.deepEqual(harness.session.submissionError.value, {
    code: 'MESSAGE_SEND_FAILED',
    message: uiText.app.firstMessageSendFailed,
  })
  assert.equal(harness.session.runError.value, uiText.app.firstMessageSendFailed)

  const retry = harness.session.sendMessage({
    content: 'retry with attachment',
    attachments: [attachment],
  })
  assert.equal(harness.sendCalls.length, 2)
  harness.resolveSend('run_retry')

  assert.equal(await retry, true)
  assert.equal(harness.createCalls.length, 1)
  assert.deepEqual(harness.createdSessionIds, ['sess_created'])
  assert.equal(harness.session.submissionError.value, null)
  assert.equal(harness.session.messages.value.length, 1)
  harness.session.disposeAgentSession()
})

test('starting or selecting another session clears submission errors', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  harness.session.startNewSession()

  const firstSend = harness.session.sendMessage('first message')
  await flushPromises()
  harness.rejectSend()
  assert.equal(await firstSend, false)
  assert.equal(harness.session.submissionError.value?.code, 'MESSAGE_SEND_FAILED')

  assert.equal(harness.session.startNewSession(), true)
  assert.equal(harness.session.submissionError.value, null)

  harness.failCreate()
  assert.equal(await harness.session.sendMessage('create fails'), false)
  assert.equal(harness.session.submissionError.value?.code, 'SESSION_CREATE_FAILED')

  assert.equal(await harness.session.loadSessionMessages('sess_existing'), true)
  assert.equal(harness.session.submissionError.value, null)
  harness.session.disposeAgentSession()
})

test('approval changes stay local for a draft and persist for an existing session', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  harness.session.startNewSession()

  assert.equal(await harness.session.setApprovalMode('auto_approve'), true)
  assert.equal(harness.session.newSessionDraft.approval_mode, 'auto_approve')
  assert.deepEqual(harness.environmentUpdates, [])

  await harness.session.loadSessionMessages('sess_existing')
  assert.equal(await harness.session.setApprovalMode('ai_review'), true)
  assert.deepEqual(harness.environmentUpdates, [{ id: 'sess_existing', approval_mode: 'ai_review' }])
  harness.session.disposeAgentSession()
})

test('selecting a persisted session discards the new session environment draft', async () => {
  const harness = createHarness([])
  await harness.session.checkServer()
  harness.session.startNewSession()
  harness.session.setDraftWorkspace('E:\\work\\project-c')
  await harness.session.setApprovalMode('auto_approve')

  assert.equal(await harness.session.loadSessionMessages('sess_existing'), true)
  assert.deepEqual(harness.session.newSessionDraft, { approval_mode: 'manual' })
  harness.session.disposeAgentSession()
})
