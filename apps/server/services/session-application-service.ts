import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { RunManager, RunOptions } from '@moke/agent-runtime';
import type {
  CreateSessionEnvironmentInput,
  FileAttachment,
  ResolvedImageAttachment,
  SendMessageEnvironmentInput,
  Session,
  SessionVisibility,
} from '@moke/protocol';
import type { SessionRepository } from '../storage/session-store.js';
import { id, maybeSetTitleFromFirstUserMessage, now } from '../domain/sessions.js';
import { applyMutableSessionEnvironmentInput, createSessionEnvironment } from './session-environment.js';

export class SessionApplicationService {
  constructor(
    private readonly sessionStore: SessionRepository,
    private readonly runManager: RunManager,
    private readonly defaultWorkspaceRoot: string,
  ) {}

  createSession(input: {
    title: string;
    metadata?: Record<string, unknown>;
    visibility?: SessionVisibility;
    env?: CreateSessionEnvironmentInput;
  }) {
    const createdAt = now();
    const sessionId = id('sess');
    const generatedWorkspace = !input.env?.workspace?.root?.trim();
    const workspaceRoot = generatedWorkspace
      ? createGeneratedWorkspaceRoot(this.defaultWorkspaceRoot, createdAt, sessionId)
      : undefined;
    if (workspaceRoot) mkdirSync(workspaceRoot, { recursive: true });
    const session: Session = {
      id: sessionId,
      title: input.title,
      visibility: input.visibility || 'visible',
      created_at: createdAt,
      updated_at: createdAt,
      messages: [],
      metadata: {
        ...(input.metadata || {}),
        ...(generatedWorkspace ? { generated_workspace: true } : {}),
      },
      env: createSessionEnvironment({
        defaultWorkspaceRoot: this.defaultWorkspaceRoot,
        env: workspaceRoot ? { ...input.env, workspace: { root: workspaceRoot } } : input.env,
      }),
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
    files?: FileAttachment[];
    options?: RunOptions;
    env?: SendMessageEnvironmentInput;
    source?: {
      kind: 'messaging';
      platform: string;
      connection_id: string;
      message_id: string;
    };
  }) {
    const content = input.content.trim();
    const attachments = input.attachments || [];
    const files = input.files || [];
    const source = input.source;
    const previousSession = structuredClone(input.session);
    if (!content && attachments.length === 0 && files.length === 0) {
      throw new Error('message.content, message.attachments, or message.files is required');
    }
    if (input.env) {
      input.session.env = applyMutableSessionEnvironmentInput(
        input.session.env,
        input.env,
        this.defaultWorkspaceRoot,
      );
    }
    const existing = source
      ? input.session.messages.find((message) => message.role === 'user'
        && message.source?.kind === source.kind
        && message.source.platform === source.platform
        && message.source.connection_id === source.connection_id
        && message.source.message_id === source.message_id)
      : undefined;
    if (!existing) {
      maybeSetTitleFromFirstUserMessage(input.session, content || (files.length ? files[0]?.name || 'File' : 'Image'));
      const createdAt = now();
      input.session.messages.push({
        id: id('msg'),
        role: 'user',
        content,
        created_at: createdAt,
        ...(attachments.length ? { attachments: attachments.map(({ data_url: _dataUrl, ...stored }) => stored) } : {}),
        ...(files.length ? { files } : {}),
        ...(source ? { source } : {}),
      });
      input.session.updated_at = createdAt;
    }
    if (!existing || input.env) this.sessionStore.save(input.session);
    try {
      const run = this.runManager.createRun(input.session, { content, attachments, files }, input.options);
      return { messageId: existing?.id || input.session.messages.at(-1)?.id || '', runId: run.id };
    } catch (error) {
      Object.assign(input.session, previousSession);
      this.sessionStore.save(input.session);
      throw error;
    }
  }
}

function createGeneratedWorkspaceRoot(defaultWorkspaceRoot: string, createdAt: string, sessionId: string) {
  const date = new Date(createdAt);
  const dateKey = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return path.join(defaultWorkspaceRoot, '.moke', 'sessions', dateKey, sessionId);
}
