import type { ReasoningEffort, Session } from '@moke/protocol';
import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
import { AttachmentStoreError, toStoredAttachment } from '../storage/attachment-store.js';
import {
  applySessionUpdate,
  forkSession,
  id,
  maybeSetTitleFromFirstUserMessage,
  now,
  summarizeSession,
} from '../domain/sessions.js';

export function registerSessionRoutes(router: Router<RoutesContext>) {
  router.post('/api/sessions', async ({ body, context, json }) => {
    const requestBody = await body();
    const session: Session = {
      id: id('sess'),
      title: typeof requestBody.title === 'string' ? requestBody.title : 'New chat',
      created_at: now(),
      updated_at: now(),
      messages: [],
      metadata: typeof requestBody.metadata === 'object' && requestBody.metadata !== null
        ? requestBody.metadata as Record<string, unknown>
        : {},
    };
    context.sessionStore.save(session);
    return json(200, { session });
  });

  router.get('/api/sessions', ({ context, json, query }) => {
    const includeArchived = query.get('include_archived') === 'true';
    const visibleSessions = context.sessionStore.list().filter(
      (session) => includeArchived || !session.archived,
    );

    return json(200, {
      sessions: visibleSessions,
      next_cursor: null,
    });
  });

  router.patch('/api/sessions/:id', async ({ body, context, json, params }) => {
    const session = getSession(context, params.id);
    const result = applySessionUpdate(session, await body());
    if (!result.ok) throw new HttpError(result.status, result.code, result.message);

    session.updated_at = now();
    context.sessionStore.save(session);
    return json(200, { session: summarizeSession(session) });
  });

  router.get('/api/sessions/:id', ({ context, json, params }) => {
    const session = getSession(context, params.id);
    return json(200, { session: summarizeSession(session), messages: session.messages });
  });

  router.post('/api/sessions/:id/fork', async ({ body, context, json, params }) => {
    const source = getSession(context, params.id);
    const requestBody = await body();
    const messageId = typeof requestBody.message_id === 'string' ? requestBody.message_id : '';
    const mode = typeof requestBody.mode === 'string' ? requestBody.mode : 'after';
    if (!messageId || mode !== 'after') {
      throw new HttpError(400, 'BAD_REQUEST', 'message_id is required and mode must be after');
    }

    const forkedSession = forkSession({ source, messageId, now: now() });
    if (!forkedSession) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Message not found');

    context.sessionStore.save(forkedSession);
    return json(200, {
      session: summarizeSession(forkedSession),
      messages: forkedSession.messages,
    });
  });

  router.post('/api/sessions/:id/messages', async ({ body, context, json, params }) => {
    const session = getSession(context, params.id);
    const requestBody = await body();
    const message = requestBody.message && typeof requestBody.message === 'object'
      ? requestBody.message as Record<string, unknown>
      : {};
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    const attachments = saveImageAttachments(context, message.attachments);
    if (!content && attachments.length === 0) {
      throw new HttpError(400, 'BAD_REQUEST', 'message.content or message.attachments is required');
    }

    maybeSetTitleFromFirstUserMessage(session, content || 'Image');
    const createdAt = now();
    session.messages.push({
      id: id('msg'),
      role: 'user',
      content,
      created_at: createdAt,
      ...(attachments.length ? { attachments: attachments.map(toStoredAttachment) } : {}),
    });
    session.updated_at = createdAt;
    context.sessionStore.save(session);

    const options = requestBody.options && typeof requestBody.options === 'object' ? requestBody.options : {};
    const run = context.runManager.createRun(session, { content, attachments }, {
      ...options,
      reasoningEffort: normalizeRunReasoningEffort((options as Record<string, unknown>).reasoningEffort),
    });

    return json(200, {
      run_id: run.id,
      session_id: session.id,
      events_url: `/api/runs/${run.id}/events`,
    });
  });
}

function normalizeRunReasoningEffort(input: unknown): ReasoningEffort | undefined {
  if (input === 'ultra') return 'max';
  return input === 'off' || input === 'low' || input === 'medium' || input === 'high' || input === 'max'
    ? input
    : undefined;
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
