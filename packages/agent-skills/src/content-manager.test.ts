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
  },
];

const loadedSkill = {
  ...catalog[0],
  content: '# Review workflow\n\nInspect behavior before reporting findings.',
};

test('content manager exposes a catalog and activates skill content per run', () => {
  const manager = new ContentManager({ catalog, maxSkills: 1 });

  assert.match(manager.buildContext(), /<available_skills>/);
  assert.match(manager.buildContext(), /code-review/);
  assert.equal(manager.addSkill(loadedSkill), 'activated');
  assert.match(manager.buildContext(), /<active_skills>/);
  assert.match(manager.buildContext(), /Inspect behavior/);
  assert.equal(manager.addSkill(loadedSkill), 'already_active');
});

test('content manager rejects skills beyond the per-run limit', () => {
  const manager = new ContentManager({ maxSkills: 1 });
  assert.equal(manager.addSkill(loadedSkill), 'activated');
  assert.equal(manager.addSkill({
    ...loadedSkill,
    id: 'frontend-design',
    name: 'Frontend design',
  }), 'limit_reached');
});

test('content manager reports oversized skill content instead of truncating it', () => {
  const manager = new ContentManager({ maxTokensPerSkill: 2 });
  assert.equal(manager.addSkill({
    ...loadedSkill,
    content: 'This content is longer than the configured budget.',
  }), 'content_too_large');
  assert.doesNotMatch(manager.buildContext(), /This content/);
});

test('content manager caps the catalog context', () => {
  const manager = new ContentManager({
    catalog: [
      ...catalog,
      { ...catalog[0], id: 'frontend-design', name: 'Frontend design' },
    ],
    maxCatalogTokens: 10,
  });

  assert.match(manager.buildContext(), /additional skills omitted/);
});
