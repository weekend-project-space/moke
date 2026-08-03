import { MokeApiError, MokeClient } from '@moke/agent-sdk'
import type {
  CreateSessionEnvironmentInput,
  RunLifecycleListener,
  RunLifecycleOptions,
  SessionRunEventListener,
  SessionRunEventOptions,
  UpdateSessionEnvironmentInput,
} from '@moke/agent-sdk'
import type { ImageAttachment, Message, ReasoningEffort, SessionSummary } from '../model/conversation'
import { apiFetch, getApiToken } from '../../../services/apiAccess'

export type SendMessageRequest = {
  content: string
  attachments: ImageAttachment[]
  reasoningEffort?: ReasoningEffort
}

export { MokeApiError as AgentApiError }

export function createAgentApi(apiBase: string, fetcher: typeof fetch = apiFetch) {
  const client = new MokeClient({ baseUrl: apiBase, fetch: fetcher, token: getApiToken() })

  return {
    async checkHealth() {
      try {
        await client.health()
        return true
      } catch {
        return false
      }
    },

    async createSession(title: string, env?: CreateSessionEnvironmentInput) {
      return (await client.sessions.create({ title, env })).id
    },

    listSessions(): Promise<SessionSummary[]> {
      return client.sessions.list()
    },

    onRunLifecycle(listener: RunLifecycleListener, options?: RunLifecycleOptions) {
      return client.onRunLifecycle(listener, options)
    },

    onSessionRunEvent(sessionId: string, listener: SessionRunEventListener, options?: SessionRunEventOptions) {
      return client.session(sessionId).onRunEvent(listener, options)
    },

    async updateSession(id: string, payload: Record<string, unknown>) {
      await client.sessions.update(id, payload)
    },

    async updateSessionEnvironment(id: string, input: UpdateSessionEnvironmentInput) {
      await client.session(id).updateEnvironment(input)
    },

    async loadSessionMessages(id: string, signal?: AbortSignal): Promise<Message[]> {
      return await client.session(id).messages({ signal }) as Message[]
    },

    async forkSession(id: string, messageId: string) {
      const session = await client.session(id).fork({ messageId, mode: 'after' })
      return { sessionId: session.id, messages: await session.messages() as Message[] }
    },

    async sendMessage(sessionId: string, input: SendMessageRequest) {
      return client.session(sessionId).send({
        content: input.content,
        attachments: input.attachments,
        reasoningEffort: input.reasoningEffort,
      })
    },
  }
}

export type AgentApi = ReturnType<typeof createAgentApi>
