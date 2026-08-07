import { basename, isAbsolute, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { SessionRunActiveError } from '@moke/agent-runtime';
import type { FileAttachmentInput, Message, Session } from '@moke/protocol';
import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { AttachmentStoreError, toStoredAttachment } from '../storage/attachment-store.js';
import {
  createSessionSchema,
  forkSessionSchema,
  idParamsSchema,
  listSessionsQuerySchema,
  sendMessageSchema,
  updateSessionSchema,
  updateSessionEnvironmentSchema,
} from './schemas.js';
import { parseBody, parseInput, parseParams, parseQuery } from '../http/validation.js';
import {
  applySessionUpdate,
  forkSession,
  id,
  now,
  summarizeSession,
} from '../domain/sessions.js';
import { SessionApplicationService } from '../services/session-application-service.js';
import { applyMutableSessionEnvironmentInput, SessionEnvironmentError } from '../services/session-environment.js';

export function registerSessionRoutes(router: Router<RoutesContext>) {
  router.post('/api/sessions', async ({ body, context, json }) => {
    const requestBody = await parseBody(body, createSessionSchema);
    const session = withEnvironmentError(() =>
      new SessionApplicationService(context.sessionStore, context.runManager, context.defaultWorkspaceRoot).createSession({
        title: requestBody.title || 'New chat',
        metadata: requestBody.metadata,
        env: requestBody.env,
      }));
    return json(200, { session });
  });

  router.get('/api/sessions', ({ context, json, query }) => {
    const { include_archived: includeArchived } = parseQuery(query, listSessionsQuerySchema);
    const visibleSessions = context.sessionStore.list().filter(
      (session) => includeArchived === 'true' || !session.archived,
    );

    return json(200, {
      sessions: visibleSessions,
      next_cursor: null,
    });
  });

  router.patch('/api/sessions/:id', async ({ body, context, json, params }) => {
    const { id: sessionId } = parseParams(params, idParamsSchema);
    const session = getSession(context, sessionId);
    const result = applySessionUpdate(session, await parseBody(body, updateSessionSchema));
    if (!result.ok) throw new HttpError(result.status, result.code, result.message);

    session.updated_at = now();
    context.sessionStore.save(session);
    return json(200, { session: summarizeSession(session) });
  });

  router.patch('/api/sessions/:id/env', async ({ body, context, json, params }) => {
    const { id: sessionId } = parseParams(params, idParamsSchema);
    const session = getSession(context, sessionId);
    const rawInput = await body();
    rejectImmutableWorkspace(rawInput);
    const input = parseInput(updateSessionEnvironmentSchema, rawInput);
    session.env = withEnvironmentError(() => applyMutableSessionEnvironmentInput(
      session.env,
      input,
      context.defaultWorkspaceRoot,
    ));
    session.updated_at = now();
    context.sessionStore.save(session);
    return json(200, { session: summarizeSession(session) });
  });

  router.get('/api/sessions/:id', ({ context, json, params }) => {
    const { id: sessionId } = parseParams(params, idParamsSchema);
    const session = getSession(context, sessionId);
    return json(200, {
      session: { ...summarizeSession(session), metadata: session.metadata },
      messages: publicMessages(session.messages),
    });
  });

  router.post('/api/sessions/:id/fork', async ({ body, context, json, params }) => {
    const { id: sessionId } = parseParams(params, idParamsSchema);
    const source = getSession(context, sessionId);
    const { message_id: messageId } = await parseBody(body, forkSessionSchema);

    const forkedSession = forkSession({ source, messageId, now: now() });
    if (!forkedSession) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Message not found');

    context.sessionStore.save(forkedSession);
    return json(200, {
      session: summarizeSession(forkedSession),
      messages: publicMessages(forkedSession.messages),
    });
  });

  router.post('/api/sessions/:id/messages', async ({ body, context, json, params }) => {
    const { id: sessionId } = parseParams(params, idParamsSchema);
    const session = getSession(context, sessionId);
    const rawRequestBody = await body();
    rejectImmutableWorkspace(environmentFromSendRequest(rawRequestBody));
    const requestBody = parseInput(sendMessageSchema, rawRequestBody);
    rejectActiveSessionRun(context, sessionId);
    const content = requestBody.message.content.trim();
    const attachments = saveImageAttachments(context, requestBody.message.attachments);
    const files = saveFileReferences(requestBody.message.files);
    if (!content && attachments.length === 0 && files.length === 0) {
      throw new HttpError(400, 'BAD_REQUEST', 'message.content, message.attachments, or message.files is required');
    }

    const sessionApplicationService = new SessionApplicationService(context.sessionStore, context.runManager, context.defaultWorkspaceRoot);
    const result = withEnvironmentError(() => sessionApplicationService.acceptUserMessage({
      session,
      content,
      attachments,
      files,
      env: requestBody.env,
      options: {
      ...requestBody.options,
      reasoningEffort: requestBody.options.reasoningEffort === 'ultra' ? 'max' : requestBody.options.reasoningEffort,
      },
    }));

    return json(200, {
      run_id: result.runId,
      session_id: session.id,
      events_url: `/api/runs/${result.runId}/events`,
    });
  });
}

function environmentFromSendRequest(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>).env;
}

function rejectImmutableWorkspace(value: unknown) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'workspace')) return;
  throw new HttpError(
    400,
    'IMMUTABLE_SESSION_WORKSPACE',
    'Session workspace can only be set when the session is created',
  );
}

function withEnvironmentError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SessionRunActiveError) {
      throw new HttpError(409, error.code, error.message);
    }
    if (error instanceof SessionEnvironmentError) {
      throw new HttpError(400, error.code, error.message);
    }
    throw error;
  }
}

function rejectActiveSessionRun(context: RoutesContext, sessionId: string) {
  const activeRun = context.runManager.getActiveRunForSession(sessionId);
  if (!activeRun) return;
  throw new HttpError(
    409,
    'SESSION_RUN_ACTIVE',
    `Session ${sessionId} already has an active run: ${activeRun.id}`,
  );
}

function saveImageAttachments(context: RoutesContext, input: unknown) {
  try {
    return context.attachmentStore.saveImages(input);
  } catch (error) {
    if (error instanceof AttachmentStoreError) {
      throw new HttpError(error.status, error.code, error.message);
    }
    throw error;
  }
}

function saveFileReferences(input: FileAttachmentInput[] | undefined) {
  return (input || []).map((file) => {
    const rawPath = file.path.trim();
    if (!isAbsolute(rawPath)) {
      throw new HttpError(400, 'INVALID_FILE_PATH', 'Attached file paths must be absolute');
    }

    const path = resolve(rawPath);
    let size: number;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) throw new Error('not a file');
      size = stats.size;
    } catch {
      throw new HttpError(400, 'FILE_NOT_FOUND', 'Attached file is not available: ' + path);
    }

    return {
      id: id('file'),
      kind: 'file' as const,
      name: basename(path),
      path,
      size,
    };
  });
}

function getSession(context: RoutesContext, id: string) {
  const session = context.sessionStore.get(id);
  if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
  return session;
}

function publicMessages(messages: Message[]) {
  return messages.filter((message) => message.role !== 'user' || message.visibility !== 'internal');
}
