import type { Session } from '../../../packages/protocol/src/index.js';
import { HttpError, type Router } from '../http/router.js';
import type { RoutesContext } from './context.js';
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
      metadata: typeof requestBody.metadata === 'object' && requestBody.metadata !== null ? requestBody.metadata : {},
    };
    context.sessions.set(session.id, session);
    context.onChange();
    return json(200, { session });
  });

  router.get('/api/sessions', ({ context, json, query }) => {
    const includeArchived = query.get('include_archived') === 'true';
    const visibleSessions = [...context.sessions.values()].filter(
      (session) => includeArchived || session.metadata?.archived !== true,
    );

    return json(200, {
      sessions: visibleSessions.map(summarizeSession),
      next_cursor: null,
    });
  });

  router.patch('/api/sessions/:id', async ({ body, context, json, params }) => {
    const session = getSession(context, params.id);
    const result = applySessionUpdate(session, await body());
    if (!result.ok) throw new HttpError(result.status, result.code, result.message);

    session.updated_at = now();
    context.onChange();
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

    context.sessions.set(forkedSession.id, forkedSession);
    context.onChange();
    return json(200, {
      session: summarizeSession(forkedSession),
      messages: forkedSession.messages,
    });
  });

  router.post('/api/sessions/:id/messages', async ({ body, context, json, params }) => {
    const session = getSession(context, params.id);
    const requestBody = await body();
    const message = requestBody.message && typeof requestBody.message === 'object' ? requestBody.message : {};
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) throw new HttpError(400, 'BAD_REQUEST', 'message.content is required');

    maybeSetTitleFromFirstUserMessage(session, content);
    session.messages.push({
      id: id('msg'),
      role: 'user',
      content,
      created_at: now(),
    });
    session.updated_at = now();

    const options = requestBody.options && typeof requestBody.options === 'object' ? requestBody.options : {};
    const run = context.runManager.createRun(session, content, options);

    return json(200, {
      run_id: run.id,
      session_id: session.id,
      events_url: `/api/runs/${run.id}/events`,
    });
  });
}

function getSession(context: RoutesContext, id: string) {
  const session = context.sessions.get(id);
  if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
  return session;
}
