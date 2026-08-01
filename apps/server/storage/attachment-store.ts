import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  ImageAttachment,
  ImageAttachmentUpload,
  ResolvedImageAttachment,
  Session,
} from '@moke/protocol';
import type { SessionRepository } from './session-store.js';

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 5 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const IMAGE_TYPES = {
  'image/gif': { extension: 'gif', matches: isGif },
  'image/jpeg': { extension: 'jpg', matches: isJpeg },
  'image/png': { extension: 'png', matches: isPng },
  'image/webp': { extension: 'webp', matches: isWebp },
} as const;

type SupportedMimeType = keyof typeof IMAGE_TYPES;

export class AttachmentStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AttachmentFile = {
  data: Buffer;
  mimeType: SupportedMimeType;
  sha256: string;
};

export class AttachmentStore {
  private readonly blobsPath: string;
  private readonly migrationMarkerPath: string;
  private readonly migrationCompletePath: string;

  constructor(private readonly storePath: string) {
    this.blobsPath = join(storePath, 'attachments', 'blobs');
    this.migrationMarkerPath = join(storePath, 'attachments', '.migration-in-progress');
    this.migrationCompletePath = join(storePath, 'attachments', '.migration-v1-complete');
  }

  saveImages(input: unknown): ResolvedImageAttachment[] {
    if (input === undefined) return [];
    if (!Array.isArray(input)) throw badRequest('message.attachments must be an array');
    if (input.length > MAX_IMAGE_ATTACHMENTS) {
      throw badRequest(`message.attachments supports at most ${MAX_IMAGE_ATTACHMENTS} images`);
    }

    let totalBytes = 0;
    const prepared = input.map((item, index) => {
      const upload = normalizeUpload(item, index);
      const { data, mimeType } = decodeImageDataUrl(upload.data_url, upload.mime_type, index);
      if (data.length > MAX_IMAGE_FILE_BYTES) {
        throw new AttachmentStoreError(413, 'PAYLOAD_TOO_LARGE', `Image ${index + 1} is too large`);
      }
      totalBytes += data.length;
      if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
        throw new AttachmentStoreError(413, 'PAYLOAD_TOO_LARGE', 'Image attachments are too large');
      }
      return { upload, data, mimeType };
    });
    return prepared.map(({ upload, data, mimeType }) => this.saveImage(upload, data, mimeType));
  }

  saveInboundImage(data: Buffer, name?: string): ResolvedImageAttachment {
    if (data.length > MAX_IMAGE_FILE_BYTES) {
      throw new AttachmentStoreError(413, 'PAYLOAD_TOO_LARGE', 'Image is too large');
    }
    const mimeType = detectMimeType(data);
    if (!mimeType) throw badRequest('Unsupported image format');
    const upload: ImageAttachmentUpload = {
      id: `img_${randomUUID().slice(0, 8)}`,
      kind: 'image',
      ...(name ? { name: name.slice(0, 120) } : {}),
      mime_type: mimeType,
      data_url: `data:${mimeType};base64,${data.toString('base64')}`,
    };
    return this.saveImage(upload, data, mimeType);
  }

  resolve(attachment: ImageAttachment): ResolvedImageAttachment {
    const mimeType = normalizeMimeType(attachment.mime_type);
    const expectedPath = relativeBlobPath(attachment.sha256, mimeType);
    if (attachment.relative_path !== expectedPath) throw new Error(`Invalid attachment path: ${attachment.relative_path}`);
    const file = this.readAndVerify(this.blobPath(attachment.sha256, mimeType), mimeType, attachment.sha256);
    if (file.length !== attachment.size) throw new Error(`Attachment size mismatch: ${attachment.id}`);
    return {
      ...attachment,
      data_url: `data:${mimeType};base64,${file.toString('base64')}`,
    };
  }

  open(sha256: string): AttachmentFile | undefined {
    if (!SHA256_PATTERN.test(sha256)) return undefined;
    for (const [mimeType, definition] of Object.entries(IMAGE_TYPES) as Array<[SupportedMimeType, typeof IMAGE_TYPES[SupportedMimeType]]>) {
      const filePath = join(this.blobsPath, `${sha256}.${definition.extension}`);
      if (!existsSync(filePath)) continue;
      return { data: this.readAndVerify(filePath, mimeType, sha256), mimeType, sha256 };
    }
    return undefined;
  }

  migrateInlineAttachments(repository: SessionRepository) {
    if (existsSync(this.migrationCompletePath)) return 0;
    mkdirSync(join(this.storePath, 'attachments'), { recursive: true });
    writeFileSync(this.migrationMarkerPath, `${new Date().toISOString()}\n`);
    let migrated = 0;

    for (const summary of repository.list()) {
      const session = repository.get(summary.id);
      if (!session) continue;
      let changed = false;
      for (const message of session.messages) {
        if (message.role !== 'user' || !message.attachments?.length) continue;
        const nextAttachments: ImageAttachment[] = [];
        for (const attachment of message.attachments as unknown[]) {
          if (isStoredAttachment(attachment)) {
            nextAttachments.push(attachment);
            continue;
          }
          const resolved = this.saveImages([attachment])[0];
          nextAttachments.push(toStoredAttachment(resolved));
          migrated++;
          changed = true;
        }
        message.attachments = nextAttachments;
      }
      if (changed) repository.save(session);
    }

    repository.flush();
    writeFileSync(this.migrationCompletePath, `${new Date().toISOString()}\n`);
    rmSync(this.migrationMarkerPath, { force: true });
    return migrated;
  }

  private saveImage(
    upload: ImageAttachmentUpload,
    data: Buffer,
    mimeType: SupportedMimeType,
  ): ResolvedImageAttachment {
    const sha256 = digest(data);
    const relativePath = relativeBlobPath(sha256, mimeType);
    const filePath = this.blobPath(sha256, mimeType);
    if (!existsSync(filePath)) writeFileAtomically(filePath, data);
    return {
      id: upload.id,
      kind: 'image',
      name: upload.name,
      mime_type: mimeType,
      relative_path: relativePath,
      size: data.length,
      sha256,
      data_url: upload.data_url,
    };
  }

  private blobPath(sha256: string, mimeType: SupportedMimeType) {
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`Invalid attachment checksum: ${sha256}`);
    return join(this.blobsPath, `${sha256}.${IMAGE_TYPES[mimeType].extension}`);
  }

  private readAndVerify(filePath: string, mimeType: SupportedMimeType, expectedSha256: string) {
    const data = readFileSync(filePath);
    if (!IMAGE_TYPES[mimeType].matches(data) || digest(data) !== expectedSha256) {
      throw new Error(`Attachment integrity check failed: ${filePath}`);
    }
    return data;
  }
}

export function toStoredAttachment(attachment: ResolvedImageAttachment): ImageAttachment {
  const { data_url: _dataUrl, ...stored } = attachment;
  return stored;
}

function normalizeUpload(input: unknown, index: number): ImageAttachmentUpload {
  if (!input || typeof input !== 'object') throw badRequest(`message.attachments[${index}] must be an object`);
  const candidate = input as Partial<ImageAttachmentUpload>;
  return {
    id: typeof candidate.id === 'string' && SAFE_ID_PATTERN.test(candidate.id)
      ? candidate.id
      : `img_${randomUUID().slice(0, 8)}`,
    kind: 'image',
    name: typeof candidate.name === 'string' ? candidate.name.slice(0, 120) : undefined,
    mime_type: normalizeMimeType(candidate.mime_type, index),
    data_url: typeof candidate.data_url === 'string' ? candidate.data_url.trim() : '',
  };
}

function decodeImageDataUrl(dataUrl: string, declaredMimeType: string, index: number) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) {
    throw badRequest(`message.attachments[${index}].data_url must be valid base64 image data`);
  }
  const mimeType = normalizeMimeType(match[1], index);
  if (mimeType !== declaredMimeType) {
    throw badRequest(`message.attachments[${index}].data_url must match its image mime_type`);
  }
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || !IMAGE_TYPES[mimeType].matches(data)) {
    throw badRequest(`message.attachments[${index}] content does not match its image mime_type`);
  }
  return { data, mimeType };
}

function normalizeMimeType(input: unknown, index?: number): SupportedMimeType {
  const mimeType = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (mimeType in IMAGE_TYPES) return mimeType as SupportedMimeType;
  const prefix = index === undefined ? 'attachment' : `message.attachments[${index}]`;
  throw badRequest(`${prefix}.mime_type must be PNG, JPEG, WebP, or GIF`);
}

function detectMimeType(data: Buffer): SupportedMimeType | undefined {
  return (Object.entries(IMAGE_TYPES) as Array<[SupportedMimeType, typeof IMAGE_TYPES[SupportedMimeType]]>)
    .find(([, definition]) => definition.matches(data))?.[0];
}

function relativeBlobPath(sha256: string, mimeType: SupportedMimeType) {
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`Invalid attachment checksum: ${sha256}`);
  return `attachments/blobs/${sha256}.${IMAGE_TYPES[mimeType].extension}`;
}

function writeFileAtomically(filePath: string, data: Buffer) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, data);
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function isStoredAttachment(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImageAttachment>;
  if (
    typeof candidate.mime_type !== 'string'
    || !(candidate.mime_type in IMAGE_TYPES)
    || typeof candidate.sha256 !== 'string'
    || !SHA256_PATTERN.test(candidate.sha256)
  ) {
    return false;
  }
  const mimeType = candidate.mime_type as SupportedMimeType;
  return typeof candidate.id === 'string'
    && SAFE_ID_PATTERN.test(candidate.id)
    && candidate.kind === 'image'
    && candidate.relative_path === relativeBlobPath(candidate.sha256, mimeType)
    && Number.isInteger(candidate.size)
    && (candidate.size || 0) > 0;
}

function digest(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

function badRequest(message: string) {
  return new AttachmentStoreError(400, 'BAD_REQUEST', message);
}

function isPng(data: Buffer) {
  return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpeg(data: Buffer) {
  return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

function isGif(data: Buffer) {
  const header = data.subarray(0, 6).toString('ascii');
  return header === 'GIF87a' || header === 'GIF89a';
}

function isWebp(data: Buffer) {
  return data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP';
}
