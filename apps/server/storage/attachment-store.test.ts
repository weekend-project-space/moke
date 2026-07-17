import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ImageAttachmentUpload, Session } from '@moke/protocol';
import { summarizeSession } from '../domain/sessions.js';
import { AttachmentStore, AttachmentStoreError, toStoredAttachment } from './attachment-store.js';
import { JsonSessionStore } from './session-store.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2kAAAAASUVORK5CYII=';

function upload(id: string): ImageAttachmentUpload {
  return {
    id,
    kind: 'image',
    name: 'pixel.png',
    mime_type: 'image/png',
    data_url: PNG_DATA_URL,
  };
}

test('attachment store writes content-addressed blobs and resolves model data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-attachment-'));
  try {
    const store = new AttachmentStore(directory);
    const first = store.saveImages([upload('img_first')])[0];
    const second = store.saveImages([upload('img_second')])[0];
    const stored = toStoredAttachment(first);

    assert.equal(first.sha256, second.sha256);
    assert.equal(readdirSync(join(directory, 'attachments', 'blobs')).length, 1);
    assert.equal('data_url' in stored, false);
    assert.equal(store.resolve(stored).data_url, PNG_DATA_URL);
    assert.equal(store.open(first.sha256)?.mimeType, 'image/png');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('attachment store rejects image data that does not match its mime type', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-attachment-invalid-'));
  try {
    const store = new AttachmentStore(directory);
    assert.throws(
      () => store.saveImages([{ ...upload('img_invalid'), data_url: 'data:image/png;base64,SGVsbG8=' }]),
      (error) => error instanceof AttachmentStoreError && error.status === 400,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('attachment migration replaces inline data and is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-attachment-migration-'));
  const storePath = join(directory, 'store');
  const legacyStatePath = join(directory, 'state.json');
  const session = {
    id: 'sess_legacy_image',
    title: 'Legacy image',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    metadata: {},
    messages: [{
      id: 'msg_image',
      role: 'user',
      content: '',
      created_at: '2026-01-01T00:00:00.000Z',
      attachments: [upload('img_legacy')],
    }],
  } as unknown as Session;

  try {
    const sessions = new JsonSessionStore({ storePath, legacyStatePath, summarizeSession });
    sessions.initialize();
    sessions.save(session);
    sessions.flush();
    const attachments = new AttachmentStore(storePath);

    assert.equal(attachments.migrateInlineAttachments(sessions), 1);
    assert.equal(attachments.migrateInlineAttachments(sessions), 0);
    const storedSession = JSON.parse(
      readFileSync(join(storePath, 'sessions', 'sess_legacy_image.json'), 'utf8'),
    ) as Session;
    const storedAttachment = storedSession.messages[0]?.role === 'user'
      ? storedSession.messages[0].attachments?.[0]
      : undefined;
    assert.equal('data_url' in (storedAttachment || {}), false);
    assert.equal(typeof storedAttachment?.relative_path, 'string');
    assert.equal(typeof storedAttachment?.sha256, 'string');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
