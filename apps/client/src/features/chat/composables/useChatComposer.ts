import { computed, nextTick, ref, type Ref } from 'vue'

import { uiText } from '../../../text/uiText'
import type { FileAttachmentInput, ImageAttachment, PendingAsk, ReasoningEffort } from '../model/conversation'
import { useQueuedMessages, type QueuedMessage } from './useQueuedMessages'

type UseChatComposerOptions = {
  cancelRun: () => void | Promise<void>
  currentRunOptions: () => { reasoningEffort?: ReasoningEffort } | undefined
  isRunning: Readonly<Ref<boolean>>
  maxQueuedMessages?: number
  onFocus: () => void
  onResize: () => void
  pendingAsk: Readonly<Ref<PendingAsk | null>>
  runId: Readonly<Ref<string>>
  sendMessage: (message: QueuedMessage) => Promise<boolean>
  serverStatus: Readonly<Ref<'checking' | 'online' | 'offline'>>
  sessionId: Readonly<Ref<string>>
}

export function useChatComposer(options: UseChatComposerOptions) {
  const maxQueuedMessages = options.maxQueuedMessages ?? 3
  const input = ref('')
  const attachments = ref<ImageAttachment[]>([])
  const files = ref<FileAttachmentInput[]>([])
  const queue = useQueuedMessages(maxQueuedMessages)

  const hasDraftContent = computed(() => Boolean(input.value.trim()) || attachments.value.length > 0 || files.value.length > 0)
  const primaryDisabled = computed(() => {
    if (options.isRunning.value) {
      if (options.pendingAsk.value) return true
      if (hasDraftContent.value) return queue.count.value >= maxQueuedMessages
      return !options.runId.value
    }
    return options.serverStatus.value !== 'online' || !hasDraftContent.value
  })
  const primaryIsStop = computed(
    () => options.isRunning.value && !options.pendingAsk.value && !hasDraftContent.value,
  )
  const queuedMessageLabel = computed(() =>
    queue.stopRequested.value
      ? uiText.composer.stoppingNext
      : uiText.composer.nextUp(queue.count.value),
  )
  const queuedMessageItems = computed(() =>
    queue.messages.value.map((message) => {
      const preview = draftTextPreview(message)
      return {
        attachmentCount: message.attachments.length + (message.files?.length || 0),
        content: preview,
        preview,
      }
    }),
  )

  async function resize() {
    await nextTick()
    options.onResize()
  }

  function clearDraft() {
    input.value = ''
    attachments.value = []
    files.value = []
    void resize()
  }

  async function submitMessage() {
    const content = input.value.trim()
    if ((!content && !attachments.value.length && !files.value.length) || options.isRunning.value) return false
    return sendCurrentDraft({
      content,
      attachments: [...attachments.value],
      files: [...files.value],
      options: options.currentRunOptions(),
    })
  }

  async function sendCurrentDraft(draft: QueuedMessage) {
    const previousInput = input.value
    const previousAttachments = [...attachments.value]
    const previousFiles = [...files.value]
    input.value = ''
    attachments.value = []
    files.value = []
    await resize()

    if (await options.sendMessage(draft)) return true

    input.value = previousInput || draft.content
    attachments.value = previousAttachments.length ? previousAttachments : draft.attachments
    files.value = previousFiles.length ? previousFiles : (draft.files || [])
    await resize()
    return false
  }

  function queueCurrentInput() {
    const content = input.value.trim()
    if ((!content && !attachments.value.length && !files.value.length) || !options.sessionId.value) return false
    const queued = queue.enqueue(options.sessionId.value, {
      content,
      attachments: [...attachments.value],
      files: [...files.value],
      options: options.currentRunOptions(),
    })
    if (!queued) return false

    input.value = ''
    attachments.value = []
    files.value = []
    void nextTick(() => {
      options.onResize()
      options.onFocus()
    })
    return true
  }

  function handlePrimaryAction() {
    if (options.isRunning.value) {
      if (hasDraftContent.value) {
        queueCurrentInput()
      } else if (!options.pendingAsk.value) {
        void options.cancelRun()
      }
      return
    }
    void submitMessage()
  }

  function sendOnEnter(event: KeyboardEvent) {
    if (event.shiftKey) return
    if (options.isRunning.value && !hasDraftContent.value) return
    event.preventDefault()
    handlePrimaryAction()
  }

  function stopAndSendQueuedMessage() {
    if (!queue.messages.value.length || !options.isRunning.value || options.pendingAsk.value) return
    if (!queue.requestStop()) return
    void options.cancelRun()
  }

  async function sendQueuedMessageIfReady() {
    if (!queue.messages.value.length || options.isRunning.value) return
    const nextMessage = queue.takeNext(options.sessionId.value)
    if (!nextMessage || await options.sendMessage(nextMessage)) return

    if (!hasDraftContent.value) {
      input.value = nextMessage.content
      attachments.value = nextMessage.attachments
      files.value = nextMessage.files || []
      await resize()
    } else {
      queue.enqueue(options.sessionId.value, nextMessage)
    }
  }

  function applySuggestion(prompt: string) {
    input.value = prompt
    void nextTick(() => {
      options.onResize()
      options.onFocus()
    })
  }

  function addAttachments(nextAttachments: ImageAttachment[]) {
    attachments.value = [...attachments.value, ...nextAttachments].slice(0, 4)
  }

  function removeAttachment(id: string) {
    attachments.value = attachments.value.filter((attachment) => attachment.id !== id)
  }

  function addFiles(nextFiles: FileAttachmentInput[]) {
    const paths = new Set(files.value.map((file) => file.path.toLowerCase()))
    files.value = [...files.value, ...nextFiles.filter((file) => !paths.has(file.path.toLowerCase()))].slice(0, 10)
  }

  function removeFile(path: string) {
    files.value = files.value.filter((file) => file.path !== path)
  }

  function draftTextPreview(message: QueuedMessage) {
    const text = message.content.trim()
      || (message.files?.length ? uiText.composer.fileAttachment : uiText.composer.imageAttachment)
    return text.length > 120 ? `${text.slice(0, 120)}...` : text
  }

  return {
    addAttachments,
    addFiles,
    applySuggestion,
    attachments,
    files,
    cancelQueuedMessage: queue.clear,
    cancelQueuedMessageAt: queue.remove,
    clearDraft,
    clearQueuedMessages: queue.clear,
    handleInput: options.onResize,
    handlePrimaryAction,
    input,
    primaryDisabled,
    primaryIsStop,
    queuedMessageCount: queue.count,
    queuedMessageItems,
    queuedMessageLabel,
    queuedStopRequested: queue.stopRequested,
    removeAttachment,
    removeFile,
    sendOnEnter,
    sendQueuedMessageIfReady,
    submitMessage,
    queueCurrentInput,
    stopAndSendQueuedMessage,
  }
}
