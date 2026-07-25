type StreamingTextBufferOptions = {
  flushIntervalMs?: number
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => number
  clearTimer?: (timer: number) => void
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (frame: number) => void
  onFlush: (sessionId: string, text: string) => void
}

export type StreamingTextBuffer = {
  append: (sessionId: string, content: string) => void
  clear: (sessionId: string) => void
}

const DEFAULT_FLUSH_INTERVAL_MS = 50

export function createStreamingTextBuffer(options: StreamingTextBufferOptions) {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const now = options.now || (() => performance.now())
  const setTimer = options.setTimer || ((callback, delay) => window.setTimeout(callback, delay))
  const clearTimer = options.clearTimer || ((timer) => window.clearTimeout(timer))
  const requestFrame = options.requestFrame || ((callback) => window.requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame || ((frame) => window.cancelAnimationFrame(frame))
  const buffers = new Map<string, string>()
  const flushFrames = new Map<string, number>()
  const flushTimers = new Map<string, number>()
  const lastFlushAt = new Map<string, number>()

  function cancelScheduledFlush(sessionId: string) {
    const timer = flushTimers.get(sessionId)
    if (timer !== undefined) clearTimer(timer)
    flushTimers.delete(sessionId)

    const frame = flushFrames.get(sessionId)
    if (frame !== undefined) cancelFrame(frame)
    flushFrames.delete(sessionId)
  }

  function flush(sessionId: string) {
    cancelScheduledFlush(sessionId)
    options.onFlush(sessionId, buffers.get(sessionId) || '')
    lastFlushAt.set(sessionId, now())
  }

  function scheduleFlush(sessionId: string) {
    if (flushTimers.has(sessionId) || flushFrames.has(sessionId)) return

    const elapsed = now() - (lastFlushAt.get(sessionId) || 0)
    const delay = Math.max(0, flushIntervalMs - elapsed)
    const scheduleFrame = () => {
      flushTimers.delete(sessionId)
      flushFrames.set(sessionId, requestFrame(() => flush(sessionId)))
    }

    if (delay <= 0) scheduleFrame()
    else flushTimers.set(sessionId, setTimer(scheduleFrame, delay))
  }

  function append(sessionId: string, content: string) {
    if (!content) return
    buffers.set(sessionId, `${buffers.get(sessionId) || ''}${content}`)
    scheduleFlush(sessionId)
  }

  function clear(sessionId: string) {
    cancelScheduledFlush(sessionId)
    buffers.delete(sessionId)
    lastFlushAt.delete(sessionId)
    options.onFlush(sessionId, '')
  }

  return { append, clear }
}
