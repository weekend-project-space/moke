import type {
  ImageAttachment,
  Message,
  PendingApproval,
  PendingAsk,
  ReasoningEffort,
  SessionSummary,
} from '../model/conversation'

export type ActiveRunSummary = {
  session_id: string
  run_id: string
  status: string
  events_url: string
  pending_ask?: PendingAsk
  pending_approval?: PendingApproval
}

export type SendMessageRequest = {
  content: string
  attachments: ImageAttachment[]
  reasoningEffort?: ReasoningEffort
}

type Fetcher = typeof fetch

export class AgentApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AgentApiError'
    this.status = status
  }
}

export function createAgentApi(apiBase: string, fetcher: Fetcher = fetch) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(`${apiBase}${path}`, init)
    if (!response.ok) throw new AgentApiError(response.status, `HTTP ${response.status}`)
    return response.json() as Promise<T>
  }

  function jsonRequest(method: 'POST' | 'PATCH', body: unknown, signal?: AbortSignal): RequestInit {
    return {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }
  }

  return {
    async checkHealth() {
      const response = await fetcher(`${apiBase}/api/health`)
      return response.ok
    },

    async createSession(title: string) {
      const data = await request<{ session?: { id?: unknown } }>(
        '/api/sessions',
        jsonRequest('POST', { title }),
      )
      const id = typeof data.session?.id === 'string' ? data.session.id : ''
      if (!id) throw new Error('Invalid session response')
      return id
    },

    async listSessions() {
      const data = await request<{ sessions?: SessionSummary[] }>('/api/sessions')
      return Array.isArray(data.sessions) ? data.sessions : []
    },

    async listActiveRuns() {
      const data = await request<{ runs?: ActiveRunSummary[] }>('/api/runs/active')
      return Array.isArray(data.runs) ? data.runs : []
    },

    async updateSession(id: string, payload: Record<string, unknown>) {
      await request(`/api/sessions/${id}`, jsonRequest('PATCH', payload))
    },

    async loadSessionMessages(id: string, signal?: AbortSignal) {
      const data = await request<{ messages?: Message[] }>(`/api/sessions/${id}`, { signal })
      return Array.isArray(data.messages) ? data.messages : []
    },

    async forkSession(id: string, messageId: string) {
      const data = await request<{ session?: { id?: unknown }; messages?: Message[] }>(
        `/api/sessions/${id}/fork`,
        jsonRequest('POST', { message_id: messageId, mode: 'after' }),
      )
      const sessionId = typeof data.session?.id === 'string' ? data.session.id : ''
      if (!sessionId) throw new Error('Invalid fork response')
      return {
        sessionId,
        messages: Array.isArray(data.messages) ? data.messages : [],
      }
    },

    async sendMessage(sessionId: string, input: SendMessageRequest) {
      const data = await request<{ run_id?: unknown; events_url?: unknown }>(
        `/api/sessions/${sessionId}/messages`,
        jsonRequest('POST', {
          message: {
            role: 'user',
            content: input.content,
            ...(input.attachments.length ? { attachments: input.attachments } : {}),
          },
          options: {
            stream: true,
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          },
        }),
      )
      if (typeof data.run_id !== 'string' || typeof data.events_url !== 'string') {
        throw new Error('Invalid run response')
      }
      return { runId: data.run_id, eventsUrl: data.events_url }
    },

    async choose(runId: string, askId: string, optionId: string) {
      await request(
        `/api/runs/${runId}/respond`,
        jsonRequest('POST', { type: 'choose', request_id: askId, option_id: optionId }),
      )
    },

    async approve(
      runId: string,
      approvalId: string,
      decision: 'approved' | 'rejected',
      scope: 'once' | 'session' | 'persistent',
    ) {
      await request(
        `/api/runs/${runId}/respond`,
        jsonRequest('POST', {
          type: 'approve',
          request_id: approvalId,
          decision,
          scope,
          message: decision === 'rejected' ? 'User rejected the action' : undefined,
        }),
      )
    },

    async cancel(runId: string) {
      await request(
        `/api/runs/${runId}/respond`,
        jsonRequest('POST', { type: 'cancel', reason: 'User cancelled' }),
      )
    },
  }
}

export type AgentApi = ReturnType<typeof createAgentApi>
