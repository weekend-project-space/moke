import type { Message, Session } from '@moke/protocol';
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
} from './schemas.js';
import { parseBody, parseParams, parseQuery } from '../http/validation.js';
import {
  applySessionUpdate,
  forkSession,
  id,
  maybeSetTitleFromFirstUserMessage,
  now,
  summarizeSession,
} from '../domain/sessions.js';
import { SessionApplicationService } from '../services/session-application-service.js';

export function registerSessionRoutes(router: Router<RoutesContext>) {
  router.post('/api/sessions', async ({ body, context, json }) => {
    const requestBody = await parseBody(body, createSessionSchema);
    const session: Session = {
      id: id('sess'),
      title: requestBody.title || 'New chat',
      created_at: now(),
      updated_at: now(),
      messages: [],
      metadata: requestBody.metadata || {},
    };
    context.sessionStore.save(session);
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
    const requestBody = await parseBody(body, sendMessageSchema);
    const content = requestBody.message.content.trim();
    const attachments = saveImageAttachments(context, requestBody.message.attachments);
    if (!content && attachments.length === 0) {
      throw new HttpError(400, 'BAD_REQUEST', 'message.content or message.attachments is required');
    }

    maybeSetTitleFromFirstUserMessage(session, content || 'Image');
    const sessionApplicationService = new SessionApplicationService(context.sessionStore, context.runManager);
    const result = sessionApplicationService.acceptUserMessage({
      session,
      content,
      attachments,
      options: {
      ...requestBody.options,
      reasoningEffort: requestBody.options.reasoningEffort === 'ultra' ? 'max' : requestBody.options.reasoningEffort,
      },
    });

    return json(200, {
      run_id: result.runId,
      session_id: session.id,
      events_url: `/api/runs/${result.runId}/events`,
    });
  });
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

function getSession(context: RoutesContext, id: string) {
  const session = context.sessionStore.get(id);
  if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
  return session;
}

function publicMessages(messages: Message[]) {
  return messages.filter((message) => message.role !== 'user' || message.visibility !== 'internal');
}
