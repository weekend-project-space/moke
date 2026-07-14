import type { AgentEvent } from '../model/conversation'

const RUN_EVENT_TYPES = [
  'agent.started',
  'agent.plan',
  'agent.state',
  'agent.message.delta',
  'agent.message.done',
  'tool.call',
  'tool.result',
  'ask_user.required',
  'ask_user.answered',
  'approval.required',
  'approval.resolved',
  'agent.done',
  'agent.error',
] as const

const TRANSPORT_ONLY_EVENT_TYPES = new Set<string>(['agent.started', 'agent.plan', 'agent.state'])

type EventListener = (event: { data: string }) => void

export type EventSourceConnection = {
  addEventListener(type: string, listener: EventListener): void
  close(): void
  onerror: (() => void) | null
}

type Subscription = {
  eventsUrl: string
  source: EventSourceConnection | null
  reconnectAttempts: number
  reconnectTimer: number | undefined
}

type RunEventStreamOptions = {
  apiBase: string
  createEventSource?: (url: string) => EventSourceConnection
  setTimer?: (callback: () => void, delay: number) => number
  clearTimer?: (timer: number) => void
  onActivity?: (sessionId: string) => void
  onEvent: (sessionId: string, event: AgentEvent) => void
  onReconnecting?: (sessionId: string) => void
}

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 5_000

export function createRunEventStream(options: RunEventStreamOptions) {
  const subscriptions = new Map<string, Subscription>()
  const createSource = options.createEventSource || ((url) => new EventSource(url) as EventSourceConnection)
  const setTimer = options.setTimer || ((callback, delay) => window.setTimeout(callback, delay))
  const clearTimer = options.clearTimer || ((timer) => window.clearTimeout(timer))

  function clearReconnect(subscription: Subscription) {
    if (subscription.reconnectTimer === undefined) return
    clearTimer(subscription.reconnectTimer)
    subscription.reconnectTimer = undefined
  }

  function open(sessionId: string, subscription: Subscription) {
    const source = createSource(`${options.apiBase}${subscription.eventsUrl}`)
    subscription.source = source

    for (const type of RUN_EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        let event: AgentEvent
        try {
          event = JSON.parse(message.data) as AgentEvent
        } catch {
          return
        }

        if (subscriptions.get(sessionId) !== subscription || subscription.source !== source) return
        subscription.reconnectAttempts = 0
        options.onActivity?.(sessionId)
        if (TRANSPORT_ONLY_EVENT_TYPES.has(type)) return
        options.onEvent(sessionId, event)
      })
    }

    source.onerror = () => {
      if (subscriptions.get(sessionId) !== subscription || subscription.source !== source) {
        source.close()
        return
      }

      subscription.source = null
      source.close()
      if (subscription.reconnectTimer !== undefined) return

      subscription.reconnectAttempts += 1
      options.onReconnecting?.(sessionId)
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (subscription.reconnectAttempts - 1),
        RECONNECT_MAX_DELAY_MS,
      )
      subscription.reconnectTimer = setTimer(() => {
        subscription.reconnectTimer = undefined
        if (subscriptions.get(sessionId) === subscription) open(sessionId, subscription)
      }, delay)
    }
  }

  function subscribe(sessionId: string, eventsUrl: string) {
    close(sessionId)
    const subscription: Subscription = {
      eventsUrl,
      source: null,
      reconnectAttempts: 0,
      reconnectTimer: undefined,
    }
    subscriptions.set(sessionId, subscription)
    open(sessionId, subscription)
  }

  function close(sessionId: string) {
    const subscription = subscriptions.get(sessionId)
    if (!subscription) return
    subscriptions.delete(sessionId)
    clearReconnect(subscription)
    const source = subscription.source
    subscription.source = null
    source?.close()
  }

  function closeAll() {
    for (const sessionId of [...subscriptions.keys()]) close(sessionId)
  }

  return { close, closeAll, subscribe }
}
