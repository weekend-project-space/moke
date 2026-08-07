import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ModelProviderNotFoundError, SettingsService } from './settings-service.js';

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

test('settings resolves a session model against the selected provider', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'moke-settings-model-'));
  try {
    const settingsPath = path.join(root, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      activeProviderId: 'provider_local',
      providers: [
        { id: 'provider_local', name: 'Local', apiKey: 'key', apiBaseUrl: 'http://localhost:8080/v1', model: 'local-default' },
        { id: 'provider_cloud', name: 'Cloud', apiKey: 'key', apiBaseUrl: 'https://example.test/v1', model: 'cloud-default' },
      ],
    }));
    const service = new SettingsService(settingsPath);

    assert.deepEqual(service.resolveModelSelection({ provider_id: 'provider_cloud' }), {
      provider_id: 'provider_cloud', name: 'cloud-default',
    });
    assert.equal(service.getModelSettings({ provider_id: 'provider_cloud', name: 'cloud-fast' }).model, 'cloud-fast');
    assert.throws(() => service.resolveModelSelection({ provider_id: 'provider_missing' }), ModelProviderNotFoundError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
