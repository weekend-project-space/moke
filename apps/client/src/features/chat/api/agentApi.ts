import { MokeApiError, MokeClient } from '@moke/agent-sdk'
import type {
  CreateSessionEnvironmentInput,
  CreateWorkspaceContextInput,
  ListModelsOptions,
  ListSkillsInput,
  ModelProviderModels,
  RunLifecycleListener,
  RunLifecycleOptions,
  SendMessageEnvironmentInput,
  SessionRunEventListener,
  SessionRunEventOptions,
  SkillSummary,
  UpdateSessionEnvironmentInput,
  WorkspaceContext,
  WorkspaceEntriesInput,
  WorkspaceEntry,
} from '@moke/agent-sdk'
import type { FileAttachmentInput, ImageAttachment, Message, SessionSummary } from '../model/conversation'
import { apiFetch, getApiToken } from '../../../services/apiAccess'

export type SendMessageRequest = {
  content: string
  attachments: ImageAttachment[]
  files?: FileAttachmentInput[]
  env?: SendMessageEnvironmentInput
}

export { MokeApiError as AgentApiError }

export function createAgentApi(apiBase: string, fetcher: typeof fetch = apiFetch) {
  const client = new MokeClient({ baseUrl: apiBase, fetch: fetcher, token: getApiToken() })

  return {
    workspace: {
      createContext(input: CreateWorkspaceContextInput): Promise<WorkspaceContext> {
        return client.workspace.createContext(input)
      },
      entries(input: WorkspaceEntriesInput = {}): Promise<WorkspaceEntry[]> {
        return client.workspace.entries(input)
      },
    },

    skills: {
      list(input: ListSkillsInput = {}): Promise<SkillSummary[]> {
        return client.skills.list(input)
      },
    },

    models: {
      list(input: ListModelsOptions = {}): Promise<ModelProviderModels[]> {
        return client.models.list(input)
      },
    },

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
        files: input.files,
        env: input.env,
      })
    },
  }
}

export type AgentApi = ReturnType<typeof createAgentApi>
