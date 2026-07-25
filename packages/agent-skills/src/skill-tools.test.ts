import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContentManager } from './content-manager.js';
import { SkillLoader } from './skill-loader.js';
import { SkillRepository } from './skill-repository.js';
import { createActivateSkillTool } from './skill-tools.js';

test('activate_skill returns a compact activation record without skill content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moke-skill-tool-'));
  try {
    const repository = new SkillRepository(root);
    await repository.create({
      id: 'code-review',
      name: 'Code review',
      description: 'Review code.',
      content: '# Workflow\n\nInspect behavior before reporting findings.',
      enabled: true,
    });

    const tool = createActivateSkillTool(new SkillLoader(root));
    const output = await tool.handler({ id: 'code-review' }, {
      workspace: root,
      contentManager: new ContentManager(),
    });

    assert.deepEqual(output, {
      id: 'code-review',
      name: 'Code review',
      status: 'activated',
    });
    assert.equal('content' in output, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('activate_skill reports unavailable when no run content manager is configured', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moke-skill-tool-'));
  try {
    const repository = new SkillRepository(root);
    await repository.create({
      id: 'code-review',
      name: 'Code review',
      description: 'Review code.',
      content: '# Workflow',
      enabled: true,
    });

    const tool = createActivateSkillTool(new SkillLoader(root));
    const output = await tool.handler({ id: 'code-review' }, { workspace: root });
    assert.equal(output.status, 'unavailable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
