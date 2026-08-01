import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readMessagingDeliveryContents, validateMessagingMediaPaths } from './outbound-media.js';

test('reads validated text and workspace media into adapter delivery content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-outbound-media-'));
  try {
    writeFileSync(join(directory, 'report.txt'), 'report');
    const contents = await readMessagingDeliveryContents(directory, () => [directory], [
      { type: 'text', text: 'done' },
      { type: 'file', path: 'report.txt' },
    ]);
    assert.deepEqual(contents.map((content) => content.type), ['text', 'file']);
    assert.equal(contents[1]!.type === 'file' && contents[1].name, 'report.txt');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('requires approval for media outside the workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-outbound-media-'));
  try {
    await assert.rejects(
      () => validateMessagingMediaPaths(directory, () => [directory], [{ type: 'file', path: '../outside.txt' }]),
      /requires approval/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('allows a media path in an approved external directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moke-outbound-media-'));
  const approvedDirectory = mkdtempSync(join(tmpdir(), 'moke-outbound-approved-'));
  try {
    const filePath = join(approvedDirectory, 'report.txt');
    writeFileSync(filePath, 'report');
    await validateMessagingMediaPaths(directory, () => [directory, approvedDirectory], [{ type: 'file', path: filePath }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(approvedDirectory, { recursive: true, force: true });
  }
});
