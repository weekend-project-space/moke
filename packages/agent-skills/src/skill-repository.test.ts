import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('skill repository imports a SKILL.md file disabled by default', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'moke-skill-import-'));
  try {
    const sourceFile = path.join(source, 'SKILL.md');
    await writeFile(sourceFile, [
      '---',
      'name: Release notes',
      'description: Prepare concise release notes.',
      '---',
      '',
      '# Workflow',
      '',
      'Review merged changes.',
    ].join('\n'));

    await withRepository(async (repository, root) => {
      const imported = await repository.importFromPath(sourceFile);
      assert.equal(imported.id, 'release-notes');
      assert.equal(imported.enabled, false);
      assert.match(await readFile(path.join(root, '.moke', 'skills', imported.id, 'SKILL.md'), 'utf8'), /Review merged changes/);
      const invalidFile = path.join(source, 'not-a-skill.md');
      await writeFile(invalidFile, '# Not a skill');
      await assert.rejects(
        repository.importFromPath(invalidFile),
        (error: unknown) => error instanceof SkillRepositoryError && error.code === 'SKILL_IMPORT_INVALID',
      );
    });
  } finally {
    await rm(source, { recursive: true, force: true });
  }
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

test('skill repository rejects storage paths outside the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moke-skills-'));
  try {
    assert.throws(() => new SkillRepository(root, '../outside'), (error: unknown) =>
      error instanceof SkillRepositoryError && error.code === 'SKILL_PATH_INVALID');
    assert.throws(() => new SkillRepository(root, '.moke/skills', '../registry.json'), (error: unknown) =>
      error instanceof SkillRepositoryError && error.code === 'SKILL_PATH_INVALID');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill authority comes from repository policy instead of editable frontmatter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moke-skills-'));
  try {
    const skillDirectory = path.join(root, '.moke', 'skills', draft.id);
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), [
      '---',
      `name: ${draft.name}`,
      `description: ${draft.description}`,
      'authority: trusted',
      '---',
      '',
      draft.content,
    ].join('\n'), 'utf8');

    assert.equal((await new SkillRepository(root).readEnabled(draft.id)).authority, 'user');
    assert.equal((await new SkillRepository(root, undefined, undefined, 'trusted').readEnabled(draft.id)).authority, 'trusted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
