import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import type { MessagingDeliveryContent, OutboundContent } from '@moke/messaging-core';
import { PathRequiresApprovalError } from '@moke/agent-runtime';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function validateMessagingMediaPaths(workspace: string, approvedRoots: () => string[], contents: OutboundContent[]) {
  await Promise.all(contents.flatMap((content) =>
    content.type === 'text' ? [] : [resolveAllowedFile(workspace, approvedRoots, content.path)]));
}

export async function readMessagingDeliveryContents(workspace: string, approvedRoots: () => string[], contents: OutboundContent[]): Promise<MessagingDeliveryContent[]> {
  const result: MessagingDeliveryContent[] = [];
  for (const content of contents) {
    if (content.type === 'text') {
      const text = content.text.trim();
      if (!text) throw new Error('Outbound text cannot be empty');
      result.push({ type: 'text', text });
      continue;
    }
    const media = await readMessagingMedia(workspace, approvedRoots, content);
    result.push({
      type: media.type,
      data: media.data,
      name: media.name,
      mime_type: media.mimeType,
      ...(content.caption?.trim() ? { caption: content.caption.trim() } : {}),
    });
  }
  return result;
}

async function readMessagingMedia(workspace: string, approvedRoots: () => string[], content: Extract<OutboundContent, { type: 'image' | 'file' }>) {
  const filePath = await resolveAllowedFile(workspace, approvedRoots, content.path);
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

async function resolveAllowedFile(workspace: string, approvedRoots: () => string[], requestedPath: string) {
  if (!requestedPath.trim()) throw new Error('Outbound media path is required');
  const workspacePath = await realpath(workspace);
  const candidate = resolve(workspacePath, requestedPath);
  if (!isInsideApprovedRoot(approvedRoots(), candidate)) throw pathApprovalRequired(candidate);
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
  if (data.length >= 12 && data.subarray(0, 4).equals(Buffer.from('RIFF')) && data.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  return undefined;
}
