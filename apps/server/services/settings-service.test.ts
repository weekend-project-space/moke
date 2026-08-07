import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SettingsService } from './settings-service.js';

test('settings update keeps the previous in-memory state when persistence fails', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-settings-'));
  try {
    const blocker = path.join(root, 'not-a-directory');
    writeFileSync(blocker, 'blocker');
    const service = new SettingsService(path.join(blocker, 'settings.json'));
    const previous = service.get();

    assert.throws(() => service.updateModelProviders({
      activeProviderId: 'provider_new',
      providers: [{ id: 'provider_new', name: 'New', apiKey: 'key', apiBaseUrl: 'http://localhost:8080/v1', model: 'model' }],
    }));
    assert.deepEqual(service.get(), previous);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
