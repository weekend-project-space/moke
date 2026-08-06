import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SkillSettingsService } from './skill-settings-service.js';

test('SkillSettingsService imports, enables, and removes skills', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'moke-skill-settings-'));
  const source = await mkdtemp(path.join(tmpdir(), 'moke-skill-source-'));
  try {
    await writeFile(path.join(source, 'SKILL.md'), [
      '---',
      'name: Frontend review',
      'description: Review frontend implementation quality.',
      '---',
      '',
      '# Review',
      '',
      'Inspect behavior and layout.',
    ].join('\n'));
    const service = new SkillSettingsService(workspace);
    const imported = await service.importFromPath({ path: source });
    assert.equal(imported.valid, true);
    assert.equal(imported.enabled, false);

    const listed = await service.list();
    assert.equal(listed.skills.length, 1);
    assert.equal(listed.skills[0]?.id, 'frontend-review');
    assert.equal((await service.setEnabled('frontend-review', { enabled: true })).enabled, true);
    assert.deepEqual(await service.remove('frontend-review'), { deleted: true, id: 'frontend-review' });
    assert.equal((await service.list()).skills.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
