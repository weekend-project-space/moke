import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SkillRepository, SkillRepositoryError } from './skill-repository.js';

async function withRepository(run: (repository: SkillRepository, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'moke-skills-'));
  try {
    await run(new SkillRepository(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const draft = {
  id: 'code-review',
  name: 'Code review',
  description: 'Review code for behavior and regressions.',
  content: '# Workflow\n\nInspect the code before reporting findings.',
  enabled: true,
};

test('skill repository creates, updates, disables, and removes skills', async () => {
  await withRepository(async (repository, root) => {
    const created = await repository.create(draft);
    assert.equal(created.valid, true);
    assert.equal((await repository.listEnabled()).length, 1);
    assert.equal((await repository.readEnabled('Code review')).content, draft.content);

    const updated = await repository.update(draft.id, {
      ...draft,
      description: 'Updated description.',
      enabled: false,
    });
    assert.equal(updated.description, 'Updated description.');
    assert.equal(updated.enabled, false);
    assert.equal((await repository.listEnabled()).length, 0);
    assert.match(await readFile(path.join(root, '.moke', 'skills', draft.id, 'SKILL.md'), 'utf8'), /Updated description/);

    await repository.remove(draft.id);
    assert.deepEqual(await repository.listAll(), []);
  });
});

test('skill repository rejects duplicate names and unsafe ids', async () => {
  await withRepository(async (repository) => {
    await repository.create(draft);

    await assert.rejects(
      repository.create({ ...draft, id: 'another-skill' }),
      (error: unknown) => error instanceof SkillRepositoryError && error.code === 'SKILL_NAME_EXISTS',
    );
    await assert.rejects(
      repository.create({ ...draft, id: '../outside', name: 'Outside' }),
      (error: unknown) => error instanceof SkillRepositoryError && error.code === 'SKILL_INVALID',
    );
  });
});

test('skill repository keeps malformed skill directories repairable', async () => {
  await withRepository(async (repository, root) => {
    const invalidDirectory = path.join(root, '.moke', 'skills', 'broken');
    await mkdir(invalidDirectory, { recursive: true });

    const listed = await repository.listAll();
    assert.equal(listed[0]?.valid, false);
    assert.equal((await repository.get('broken')).content, '');

    const repaired = await repository.update('broken', {
      name: 'Broken repaired',
      description: 'Repaired skill.',
      content: '# Repaired',
      enabled: true,
    });
    assert.equal(repaired.valid, true);
  });
});
