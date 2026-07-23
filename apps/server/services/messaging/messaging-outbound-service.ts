import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import type {
  MessagingDeliveryReceipt,
  MessagingOutboundRequest,
  MessagingOutboundResult,
  OutboundContent,
} from '@moke/messaging-core';
import { PathRequiresApprovalError } from '@moke/agent-runtime';
import { MessagingConnectionManager } from './connection-manager.js';
import { JsonMessagingStore } from '../../storage/messaging-store.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface MessagingOutboundService {
  send(input: MessagingOutboundRequest): Promise<MessagingOutboundResult>;
}

export type MessagingOutboundMediaPathValidator = {
  validateMediaPaths(contents: OutboundContent[]): Promise<void>;
};

export class DefaultMessagingOutboundService implements MessagingOutboundService {
  private readonly inFlight = new Map<string, Promise<MessagingOutboundResult>>();

  constructor(
    private readonly store: JsonMessagingStore,
    private readonly connections: MessagingConnectionManager,
    private readonly workspace: string,
    private readonly approvedRoots: () => string[] = () => [workspace],
  ) {}

  send(input: MessagingOutboundRequest) {
    const existing = this.inFlight.get(input.idempotency_key);
    if (existing) return existing;
    const operation = this.performSend(input).finally(() => this.inFlight.delete(input.idempotency_key));
    this.inFlight.set(input.idempotency_key, operation);
    return operation;
  }

  async validateMediaPaths(contents: OutboundContent[]) {
    await Promise.all(contents.flatMap((content) =>
      content.type === 'text' ? [] : [resolveAllowedFile(this.workspace, this.approvedRoots, content.path)]));
  }

  private async performSend(input: MessagingOutboundRequest): Promise<MessagingOutboundResult> {
    if (!input.contents.length) throw new Error('At least one outbound content item is required');
    const binding = this.store.getBinding(input.binding_id);
    if (!binding) throw new Error('Messaging binding is not available');
    const outbox = this.store.beginOutbox(input);
    if (outbox.binding_id !== input.binding_id) throw new Error('Idempotency key belongs to a different messaging binding');
    if (outbox.state === 'completed') return { receipts: outbox.receipts };
    if (outbox.receipts.length > input.contents.length) throw new Error('Idempotency record does not match outbound contents');

    try {
      for (let index = outbox.receipts.length; index < input.contents.length; index++) {
        const content = input.contents[index];
        const receipt = await this.sendContent(binding.account_id, input.binding_id, content, input.run_id);
        this.store.appendOutboxReceipt(input.idempotency_key, receipt);
      }
      return { receipts: this.store.finishOutbox(input.idempotency_key).receipts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.failOutbox(input.idempotency_key, message);
      throw error;
    }
  }

  private async sendContent(connectionId: string, bindingId: string, content: OutboundContent, runId?: string): Promise<MessagingDeliveryReceipt> {
    if (content.type === 'text') {
      const text = content.text.trim();
      if (!text) throw new Error('Outbound text cannot be empty');
      await this.connections.sendTextForBinding(connectionId, bindingId, text);
      return { type: 'text', delivered_at: new Date().toISOString() };
    }

    const media = await this.readWorkspaceMedia(content);
    await this.connections.sendMediaForBinding(connectionId, bindingId, media, content.caption, runId);
    return { type: content.type, delivered_at: new Date().toISOString() };
  }

  private async readWorkspaceMedia(content: Extract<OutboundContent, { type: 'image' | 'file' }>): Promise<OutboundMedia> {
    const filePath = await resolveAllowedFile(this.workspace, this.approvedRoots, content.path);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error(`Outbound path is not a file: ${content.path}`);
    const maxBytes = content.type === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (metadata.size <= 0 || metadata.size > maxBytes) throw new Error(`Outbound ${content.type} exceeds the size limit`);
    const data = await readFile(filePath);
    const mimeType = content.type === 'image' ? detectImageMimeType(data) : 'application/octet-stream';
    if (content.type === 'image' && !mimeType) throw new Error('Outbound image must be PNG, JPEG, WebP, or GIF');
    return {
      type: content.type,
      data,
      name: content.type === 'file' && content.name?.trim() ? safeFileName(content.name) : basename(filePath),
      mimeType: mimeType || 'application/octet-stream',
    };
  }
}

type OutboundMedia = {
  type: 'image' | 'file';
  data: Buffer;
  name: string;
  mimeType: string;
};

async function resolveAllowedFile(workspace: string, approvedRoots: () => string[], requestedPath: string) {
  if (!requestedPath.trim()) throw new Error('Outbound media path is required');
  const workspacePath = await realpath(workspace);
  const candidate = resolve(workspacePath, requestedPath);
  if (!isInsideApprovedRoot(approvedRoots(), candidate)) {
    throw pathApprovalRequired(candidate);
  }
  const resolvedPath = await realpath(candidate);
  if (!isInsideApprovedRoot(approvedRoots(), resolvedPath)) throw pathApprovalRequired(resolvedPath);
  return resolvedPath;
}

function isInsideApprovedRoot(roots: string[], candidate: string) {
  return roots.some((root) => {
    const pathFromRoot = relative(resolve(root), candidate);
    return pathFromRoot === '' || (!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith('..') && !pathFromRoot.includes('..\\') && !pathFromRoot.includes('../'));
  });
}

function pathApprovalRequired(path: string) {
  return new PathRequiresApprovalError({
    path,
    suggestedRoot: dirname(path),
    reason: `Media path requires approval: ${path}`,
  });
}

function safeFileName(value: string) {
  const name = basename(value.trim());
  if (!name || name === '.' || name === '..') throw new Error('Outbound file name is invalid');
  return name.slice(0, 120);
}

function detectImageMimeType(data: Buffer) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
