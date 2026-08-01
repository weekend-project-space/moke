import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'

import type { QueuedMessage } from './useQueuedMessages'
import { useChatComposer } from './useChatComposer'

test('useChatComposer sends a queued message without discarding the current draft', async () => {
  const sent: QueuedMessage[] = []
  const isRunning = ref(true)
  const sessionId = ref('session_1')
  const composer = useChatComposer({
    cancelRun: () => undefined,
    currentRunOptions: () => ({ reasoningEffort: 'high' }),
    isRunning,
    onFocus: () => undefined,
    onResize: () => undefined,
    pendingAsk: ref(null),
    runId: ref('run_1'),
    sendMessage: async (message) => {
      sent.push(message)
      return true
    },
    serverStatus: ref('online'),
    sessionId,
  })

  composer.input.value = 'queued message'
  composer.attachments.value = [{
    id: 'image_1',
    kind: 'image',
    mime_type: 'image/png',
    data_url: 'data:image/png;base64,AA==',
  }]
  assert.equal(composer.queueCurrentInput(), true)
  assert.deepEqual(composer.queuedMessageItems.value, [{
    attachmentCount: 1,
    content: 'queued message',
    preview: 'queued message',
  }])
  assert.equal(composer.queuedMessageLabel.value, 'Next up')
  composer.input.value = 'draft in progress'

  isRunning.value = false
  await composer.sendQueuedMessageIfReady()

  assert.equal(sent[0]?.content, 'queued message')
  assert.deepEqual(sent[0]?.options, { reasoningEffort: 'high' })
  assert.equal(composer.input.value, 'draft in progress')
})

test('useChatComposer restores a failed direct submission', async () => {
  const composer = useChatComposer({
    cancelRun: () => undefined,
    currentRunOptions: () => undefined,
    isRunning: ref(false),
    onFocus: () => undefined,
    onResize: () => undefined,
    pendingAsk: ref(null),
    runId: ref(''),
    sendMessage: async () => false,
    serverStatus: ref('online'),
    sessionId: ref(''),
  })
  composer.input.value = 'retry me'
  composer.attachments.value = [{
    id: 'image_retry',
    kind: 'image',
    mime_type: 'image/png',
    data_url: 'data:image/png;base64,AA==',
  }]

  assert.equal(await composer.submitMessage(), false)
  assert.equal(composer.input.value, 'retry me')
  assert.equal(composer.attachments.value[0]?.id, 'image_retry')
})
