import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldPersistToolMessages } from './re-act-agent.js';

test('ask_user persists tool messages while finish remains runtime-only', () => {
  assert.equal(shouldPersistToolMessages('ask_user'), true);
  assert.equal(shouldPersistToolMessages('execute'), true);
  assert.equal(shouldPersistToolMessages('finish'), false);
});
