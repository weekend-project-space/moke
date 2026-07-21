import { MokeApiError, MokeClient } from '@moke/agent-sdk'
import type { ImageAttachment, Message, PendingApproval, PendingAsk, ReasoningEffort, SessionSummary } from '../model/conversation'

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

export { MokeApiError as AgentApiError }

export function createAgentApi(apiBase: string, fetcher: typeof fetch = fetch) {
  const client = new MokeClient({ baseUrl: apiBase, fetch: fetcher })

  return {
    async checkHealth() {
      try {
        await client.health()
        return true
      } catch {
        return false
      }
    },

    async createSession(title: string) {
      return (await client.sessions.create({ title })).id
    },

    listSessions(): Promise<SessionSummary[]> {
      return client.sessions.list()
    },

    async listActiveRuns(): Promise<ActiveRunSummary[]> {
      return (await client.runs.listActive()).map((run) => ({ ...run }))
    },

    async updateSession(id: string, payload: Record<string, unknown>) {
      await client.sessions.update(id, payload)
    },

    async loadSessionMessages(id: string, signal?: AbortSignal): Promise<Message[]> {
      return await client.session(id).messages({ signal }) as Message[]
    },

    async forkSession(id: string, messageId: string) {
      const session = await client.session(id).fork({ messageId, mode: 'after' })
      return { sessionId: session.id, messages: await session.messages() as Message[] }
    },

    async sendMessage(sessionId: string, input: SendMessageRequest) {
      const run = await client.session(sessionId).send({
        content: input.content,
        attachments: input.attachments,
        reasoningEffort: input.reasoningEffort,
      })
      return { runId: run.id, eventsUrl: `/api/runs/${run.id}/events` }
    },

    async choose(runId: string, askId: string, optionId: string) {
      await client.run(runId).answer({ requestId: askId, optionId })
    },

    async approve(
      runId: string,
      approvalId: string,
      decision: 'approved' | 'rejected',
      scope: 'once' | 'session' | 'persistent',
    ) {
      await client.run(runId).approve({
        requestId: approvalId,
        decision,
        scope,
        message: decision === 'rejected' ? 'User rejected the action' : undefined,
      })
    },

    async cancel(runId: string) {
      await client.run(runId).cancel()
    },
  }
}

export type AgentApi = ReturnType<typeof createAgentApi>
