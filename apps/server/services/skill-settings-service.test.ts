import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SkillSettingsService } from './skill-settings-service.js';

test('SkillSettingsService supports the settings management lifecycle', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'moke-skill-settings-'));
  try {
    const service = new SkillSettingsService(workspace);
    const created = await service.create({
      id: 'frontend-review',
      name: 'Frontend review',
      description: 'Review frontend implementation quality.',
      content: '# Review\n\nInspect behavior and layout.',
      enabled: true,
    });
    assert.equal(created.valid, true);

    const listed = await service.list();
    assert.equal(listed.skills.length, 1);
    assert.equal(listed.skills[0]?.id, 'frontend-review');
    assert.equal((await service.get('frontend-review')).content, '# Review\n\nInspect behavior and layout.');

    assert.deepEqual(await service.validate({
      id: 'frontend-review',
      currentId: 'frontend-review',
      name: 'Frontend review',
      description: 'Review frontend implementation quality.',
      content: '# Review',
      enabled: true,
    }), { valid: true, errors: [] });

    assert.equal((await service.setEnabled('frontend-review', { enabled: false })).enabled, false);
    assert.deepEqual(await service.remove('frontend-review'), { deleted: true, id: 'frontend-review' });
    assert.equal((await service.list()).skills.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
