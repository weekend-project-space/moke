type ScrollMetrics = {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}

export function conversationScrollState(metrics: ScrollMetrics, bottomThreshold = 48) {
  const hasOverflow = metrics.scrollHeight > metrics.clientHeight
  const distanceFromBottom = Math.max(
    0,
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight,
  )
  const isAtBottom = !hasOverflow || distanceFromBottom < bottomThreshold

  return {
    isAtBottom,
    showJumpToBottom: hasOverflow && !isAtBottom,
  }
}
