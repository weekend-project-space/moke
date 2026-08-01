import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSkillFile, serializeSkillFile } from './skill-file.js';

test('skill file parser reads YAML frontmatter and preserves extra metadata', () => {
  const parsed = parseSkillFile(`---
name: review
description: "Review code: carefully"
license: MIT
---

# Review

Check behavior first.
`, 'fallback');

  assert.equal(parsed.name, 'review');
  assert.equal(parsed.description, 'Review code: carefully');
  assert.equal(parsed.content, '# Review\n\nCheck behavior first.');
  assert.equal(parsed.metadata.license, 'MIT');

  const serialized = serializeSkillFile({ ...parsed, description: 'Updated' });
  assert.match(serialized, /license: MIT/);
  assert.equal(parseSkillFile(serialized).description, 'Updated');
});

test('skill file parser supports legacy files without frontmatter', () => {
  const parsed = parseSkillFile('# Legacy\n\nUse the existing workflow.', 'legacy');

  assert.equal(parsed.name, 'legacy');
  assert.equal(parsed.description, 'Use the existing workflow.');
});
