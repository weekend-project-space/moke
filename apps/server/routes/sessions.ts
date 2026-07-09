import type { ImageAttachment, ReasoningEffort, Session } from '../../../packages/protocol/src/index.js';
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
    const attachments = normalizeImageAttachments(message.attachments);
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
      ...(attachments.length ? { attachments } : {}),
    });
    session.updated_at = createdAt;

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

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_DATA_URL_LENGTH = 8 * 1024 * 1024;

function normalizeImageAttachments(input: unknown): ImageAttachment[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new HttpError(400, 'BAD_REQUEST', 'message.attachments must be an array');
  if (input.length > MAX_IMAGE_ATTACHMENTS) {
    throw new HttpError(400, 'BAD_REQUEST', `message.attachments supports at most ${MAX_IMAGE_ATTACHMENTS} images`);
  }

  let totalLength = 0;
  return input.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new HttpError(400, 'BAD_REQUEST', `message.attachments[${index}] must be an object`);
    }

    const candidate = item as Partial<ImageAttachment>;
    const mimeType = typeof candidate.mime_type === 'string' ? candidate.mime_type.trim().toLowerCase() : '';
    const dataUrl = typeof candidate.data_url === 'string' ? candidate.data_url.trim() : '';
    if (!mimeType.startsWith('image/')) {
      throw new HttpError(400, 'BAD_REQUEST', `message.attachments[${index}].mime_type must be an image type`);
    }
    if (!dataUrl.startsWith(`data:${mimeType};base64,`)) {
      throw new HttpError(400, 'BAD_REQUEST', `message.attachments[${index}].data_url must match its image mime_type`);
    }

    totalLength += dataUrl.length;
    if (totalLength > MAX_IMAGE_DATA_URL_LENGTH) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Image attachments are too large');
    }

    return {
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : id('img'),
      kind: 'image',
      name: typeof candidate.name === 'string' ? candidate.name.slice(0, 120) : undefined,
      mime_type: mimeType,
      data_url: dataUrl,
    };
  });
}

function getSession(context: RoutesContext, id: string) {
  const session = context.sessions.get(id);
  if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
  return session;
}
