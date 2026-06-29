import type { Session } from '../../packages/protocol/src/index.js';

export type SessionUpdateInput = {
  title?: unknown;
  archived?: unknown;
};

export type SessionUpdateResult =
  | { ok: true; changed: true }
  | { ok: false; status: 400; code: string; message: string };

export function applySessionUpdate(session: Session, input: SessionUpdateInput): SessionUpdateResult {
  let changed = false;

  if (Object.hasOwn(input, 'title')) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'title must be a non-empty string' };
    }

    session.title = title;
    changed = true;
  }

  if (Object.hasOwn(input, 'archived')) {
    if (typeof input.archived !== 'boolean') {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'archived must be a boolean' };
    }

    session.metadata = {
      ...session.metadata,
      archived: input.archived,
    };
    changed = true;
  }

  if (!changed) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'title or archived is required' };
  }

  return { ok: true, changed: true };
}
