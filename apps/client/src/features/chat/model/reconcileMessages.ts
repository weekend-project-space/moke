import type { Message } from './conversation'

export function reconcileSessionMessages(server: Message[], live: Message[]) {
  const liveById = new Map(live.flatMap(message => message.id ? [[message.id, message] as const] : []))
  const unmatchedIdless = live.filter(message => !message.id)
  const merged = server.map(message => {
    const equivalentIndex = unmatchedIdless.findIndex(current => equivalentMessage(current, message))
    if (equivalentIndex >= 0) unmatchedIdless.splice(equivalentIndex, 1)
    if (!message.id) return message
    const current = liveById.get(message.id)
    liveById.delete(message.id)
    return current && messageScore(current) > messageScore(message) ? current : message
  })

  for (const message of live) {
    if (message.id && liveById.has(message.id)) {
      merged.push(message)
      liveById.delete(message.id)
    }
  }
  merged.push(...unmatchedIdless)
  return merged
}

export function serverCoversLiveMessages(server: Message[], live: Message[]) {
  const serverById = new Map(server.flatMap(message => message.id ? [[message.id, message] as const] : []))
  return live.every(message => {
    if (!message.id) return server.some(persisted => equivalentMessage(message, persisted))
    const persisted = serverById.get(message.id)
    return Boolean(persisted && messageScore(persisted) >= messageScore(message))
  })
}

function equivalentMessage(left: Message, right: Message) {
  if (left.role !== right.role || left.content !== right.content) return false
  if (left.role !== 'user' || right.role !== 'user') return true
  return JSON.stringify(left.attachments || []) === JSON.stringify(right.attachments || [])
    && JSON.stringify(left.files?.map(file => file.path) || []) === JSON.stringify(right.files?.map(file => file.path) || [])
}

function messageScore(message: Message) {
  let score = message.content.length
  if (message.created_at) score += 1
  if (message.role === 'assistant') {
    score += (message.reasoning?.length || 0) + (message.tool_calls?.length || 0) * 100
  } else if (message.role === 'tool') {
    if (message.tool_call_id) score += 100
    if (message.status) score += 10
    score += (message.approvals?.length || 0) * 10
  } else {
    score += (message.attachments?.length || 0) * 10 + (message.files?.length || 0) * 10
  }
  return score
}
