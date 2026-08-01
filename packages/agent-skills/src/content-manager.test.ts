import assert from 'node:assert/strict';
import test from 'node:test';

import { ContentManager } from './content-manager.js';

const catalog = [
  {
    id: 'code-review',
    name: 'Code review',
    description: 'Review code for regressions.',
    path: '.moke/skills/code-review/SKILL.md',
    enabled: true,
    authority: 'user' as const,
  },
];

const loadedSkill = {
  ...catalog[0],
  content: '# Review workflow\n\nInspect behavior before reporting findings.',
};

test('content manager exposes a user-authority catalog and tracks activation per run', () => {
  const manager = new ContentManager({ catalog, maxSkills: 1 });

  const context = manager.buildInitialContext();
  assert.equal(context.length, 1);
  assert.equal(context[0].authority, 'user');
  assert.match(context[0].content, /<available_skills>/);
  assert.match(context[0].content, /code-review/);
  assert.equal(manager.addSkill(loadedSkill).status, 'activated');
  assert.doesNotMatch(manager.buildInitialContext()[0].content, /Inspect behavior/);
  assert.equal(manager.addSkill(loadedSkill).status, 'already_active');
});

test('content manager separates trusted catalogs and omits external skills', () => {
  const manager = new ContentManager({
    catalog: [
      { ...catalog[0], authority: 'external' },
      { ...catalog[0], id: 'builtin-review', authority: 'trusted' },
    ],
  });

  const context = manager.buildInitialContext();
  assert.deepEqual(context.map((item) => item.authority), ['trusted']);
  assert.match(context[0].content, /builtin-review/);
  assert.doesNotMatch(context[0].content, /id="code-review"/);
});

test('content manager rejects skills beyond the per-run limit', () => {
  const manager = new ContentManager({ maxSkills: 1 });
  assert.equal(manager.addSkill(loadedSkill).status, 'activated');
  assert.equal(manager.addSkill({
    ...loadedSkill,
    id: 'frontend-design',
    name: 'Frontend design',
  }).status, 'limit_reached');
});

test('content manager truncates oversized skill content and keeps the activation for the run', () => {
  const manager = new ContentManager({ maxTokensPerSkill: 40 });
  const originalContent = 'This content is longer than the configured budget. '.repeat(20);
  const activation = manager.addSkill({
    ...loadedSkill,
    content: originalContent,
  });

  assert.equal(activation.status, 'activated');
  assert.equal(activation.truncated, true);
  assert.ok(activation.content);
  assert.ok(activation.content.length < originalContent.length);
  assert.match(activation.content, /\[Skill content truncated to fit the context budget\.\]$/);
  assert.equal(manager.addSkill(loadedSkill).status, 'already_active');
  assert.equal(manager.buildInitialContext().length, 0);
});

test('content manager caps the catalog context', () => {
  const manager = new ContentManager({
    catalog: [
      ...catalog,
      { ...catalog[0], id: 'frontend-design', name: 'Frontend design' },
    ],
    maxCatalogTokens: 30,
  });

  assert.match(manager.buildInitialContext()[0].content, /additional skills omitted/);
});
