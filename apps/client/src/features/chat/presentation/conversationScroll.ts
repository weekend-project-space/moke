type ScrollMetrics = {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}

type TurnAnchorMetrics = {
  anchorScrollTop: number
  clientHeight: number
  currentSpacerHeight: number
  scrollHeight: number
}

export function conversationTurnSpacerHeight(metrics: TurnAnchorMetrics) {
  const naturalScrollHeight = Math.max(0, metrics.scrollHeight - metrics.currentSpacerHeight)
  return Math.max(0, Math.ceil(metrics.anchorScrollTop + metrics.clientHeight - naturalScrollHeight))
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
