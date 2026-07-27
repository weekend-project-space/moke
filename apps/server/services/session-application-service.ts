import type { RunManager, RunOptions } from '@moke/agent-runtime';
import type { ResolvedImageAttachment, Session } from '@moke/protocol';
import type { SessionRepository } from '../storage/session-store.js';
import { id, maybeSetTitleFromFirstUserMessage, now } from '../domain/sessions.js';
import { createSessionEnvironment } from './session-environment.js';

export class SessionApplicationService {
  constructor(
    private readonly sessionStore: SessionRepository,
    private readonly runManager: RunManager,
    private readonly workspace: string,
  ) {}

  createSession(input: { title: string; metadata?: Record<string, unknown>; approvalMode?: unknown }) {
    const createdAt = now();
    const session: Session = {
      id: id('sess'),
      title: input.title,
      created_at: createdAt,
      updated_at: createdAt,
      messages: [],
      metadata: input.metadata || {},
      env: createSessionEnvironment({ workspace: this.workspace, approvalMode: input.approvalMode }),
    };
    this.sessionStore.save(session);
    return session;
  }

  getSession(sessionId: string) {
    return this.sessionStore.get(sessionId);
  }

  acceptUserMessage(input: {
    session: Session;
    content: string;
    attachments?: ResolvedImageAttachment[];
    options?: RunOptions;
    source?: {
      kind: 'messaging';
      platform: string;
      connection_id: string;
      message_id: string;
    };
  }) {
    const content = input.content.trim();
    const attachments = input.attachments || [];
    const source = input.source;
    if (!content && attachments.length === 0) throw new Error('message.content or message.attachments is required');
    const existing = source
      ? input.session.messages.find((message) => message.role === 'user'
        && message.source?.kind === source.kind
        && message.source.platform === source.platform
        && message.source.connection_id === source.connection_id
        && message.source.message_id === source.message_id)
      : undefined;
    if (!existing) {
      maybeSetTitleFromFirstUserMessage(input.session, content || 'Image');
      const createdAt = now();
      input.session.messages.push({
        id: id('msg'),
        role: 'user',
        content,
        created_at: createdAt,
        ...(attachments.length ? { attachments: attachments.map(({ data_url: _dataUrl, ...stored }) => stored) } : {}),
        ...(source ? { source } : {}),
      });
      input.session.updated_at = createdAt;
      this.sessionStore.save(input.session);
    }
    const run = this.runManager.createRun(input.session, { content, attachments }, input.options);
    return { messageId: existing?.id || input.session.messages.at(-1)?.id || '', runId: run.id };
  }
}
