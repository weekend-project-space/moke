import { computed, ref } from 'vue'
import type { ImageAttachment, ReasoningEffort } from '../model/conversation'

export type QueuedMessage = {
  content: string
  attachments: ImageAttachment[]
  options?: {
    reasoningEffort?: ReasoningEffort
  }
}

export function useQueuedMessages(maxMessages = 3) {
  const messages = ref<QueuedMessage[]>([])
  const sessionId = ref('')
  const stopRequested = ref(false)
  const count = computed(() => messages.value.length)

  function enqueue(targetSessionId: string, message: QueuedMessage) {
    if (!targetSessionId || messages.value.length >= maxMessages) return false
    if (sessionId.value && sessionId.value !== targetSessionId) clear()

    messages.value = [...messages.value, message]
    sessionId.value = targetSessionId
    stopRequested.value = false
    return true
  }

  function remove(index: number) {
    if (index < 0 || index >= messages.value.length) return false

    messages.value = messages.value.filter((_, itemIndex) => itemIndex !== index)
    if (messages.value.length === 0) clear()
    return true
  }

  function takeNext(targetSessionId: string) {
    if (!messages.value.length || (sessionId.value && sessionId.value !== targetSessionId)) return null

    const [next, ...rest] = messages.value
    messages.value = rest
    stopRequested.value = false
    if (rest.length === 0) sessionId.value = ''
    return next
  }

  function requestStop() {
    if (!messages.value.length) return false
    stopRequested.value = true
    return true
  }

  function clear() {
    messages.value = []
    sessionId.value = ''
    stopRequested.value = false
  }

  return {
    clear,
    count,
    enqueue,
    messages,
    remove,
    requestStop,
    sessionId,
    stopRequested,
    takeNext,
  }
}
