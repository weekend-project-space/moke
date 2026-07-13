import type { ImageAttachment, Message, UserMessage } from './conversation'

type OptimisticUserMessageInput = {
  content: string
  attachments?: ImageAttachment[]
  createdAt?: string
}

export type OptimisticMessage = {
  message: UserMessage
  rollback: () => boolean
}

export function appendOptimisticUserMessage(
  messages: Message[],
  input: OptimisticUserMessageInput,
): OptimisticMessage {
  const message: UserMessage = {
    role: 'user',
    content: input.content,
    created_at: input.createdAt || new Date().toISOString(),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  }
  messages.push(message)

  let active = true
  return {
    message,
    rollback: () => {
      if (!active) return false
      active = false
      const index = messages.lastIndexOf(message)
      if (index < 0) return false
      messages.splice(index, 1)
      return true
    },
  }
}
