import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  SystemAccessOptions,
  ToolContext,
  WritableSystemBackend,
} from '@moke/agent-runtime';
import { createEditFileTool } from './edit-file.js';
import { createWriteFileTool } from './write-file.js';

test('write_file and edit_file pass the session permission mode to the backend', async () => {
  let writeAccess: SystemAccessOptions | undefined;
  let editAccess: SystemAccessOptions | undefined;
  const system = {
    async writeFile(_path: string, _content: string, access?: SystemAccessOptions) {
      writeAccess = access;
      return { path: 'test.txt', bytes: 4 };
    },
    async editFile(
      _path: string,
      _oldString: string,
      _newString: string,
      _options?: { replaceAll?: boolean },
      access?: SystemAccessOptions,
    ) {
      editAccess = access;
      return { path: 'test.txt', replacements: 1 };
    },
  } as unknown as WritableSystemBackend;
  const context = {
    workspace: 'E:\\root',
    run: { env: { approval_mode: 'read-only' } },
  } as unknown as ToolContext;

  await createWriteFileTool(system).handler({ path: 'test.txt', content: 'test' }, context);
  await createEditFileTool(system).handler({
    path: 'test.txt',
    old_string: 'test',
    new_string: 'next',
  }, context);

  const expectedAccess = {
    workspaceRoot: 'E:\\root',
    sandboxMode: 'read-only',
  };
  assert.deepEqual(writeAccess, expectedAccess);
  assert.deepEqual(editAccess, expectedAccess);
});
