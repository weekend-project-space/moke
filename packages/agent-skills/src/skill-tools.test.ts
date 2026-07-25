import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeRuntimeToolResult } from '@moke/agent-runtime';
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
    const output = normalizeRuntimeToolResult(await tool.handler({ id: 'code-review' }, {
      workspace: root,
      contentManager: new ContentManager(),
    }));

    assert.deepEqual(output.publicOutput, {
      id: 'code-review',
      name: 'Code review',
      status: 'activated',
      scope: 'session',
    });
    assert.equal('content' in output.publicOutput, false);
    assert.deepEqual(output.modelOutput, output.publicOutput);
    assert.equal(output.context[0].authority, 'user');
    assert.equal(output.context[0].scope, 'session');
    assert.match(output.context[0].content, /Inspect behavior/);
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
    const output = normalizeRuntimeToolResult(await tool.handler({ id: 'code-review' }, { workspace: root }));
    assert.equal(output.publicOutput.status, 'unavailable');
    assert.deepEqual(output.context, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('activate_skill reports truncation and injects only the budgeted instructions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moke-skill-tool-'));
  try {
    const repository = new SkillRepository(root);
    const originalContent = 'Step instructions. '.repeat(1000);
    await repository.create({
      id: 'large-skill',
      name: 'Large skill',
      description: 'A skill larger than the run context budget.',
      content: originalContent,
      enabled: true,
    });

    const tool = createActivateSkillTool(new SkillLoader(root));
    const output = normalizeRuntimeToolResult(await tool.handler({ id: 'large-skill' }, {
      workspace: root,
      contentManager: new ContentManager({ maxTokensPerSkill: 80 }),
    }));

    assert.equal(output.publicOutput.status, 'activated');
    assert.equal(output.publicOutput.truncated, true);
    assert.equal(output.publicOutput.notice, 'Skill instructions were truncated to fit the context budget.');
    assert.equal('content' in output.publicOutput, false);
    assert.equal(output.context[0].authority, 'user');
    assert.match(output.context[0].content, /truncated="true"/);
    assert.match(output.context[0].content, /Skill content truncated to fit the context budget/);
    assert.ok(output.context[0].content.length < originalContent.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external skill instructions remain paired with the tool result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moke-skill-tool-'));
  try {
    const repository = new SkillRepository(root);
    await repository.create({
      id: 'remote-review',
      name: 'Remote review',
      description: 'Review external code.',
      content: '# Remote workflow',
      enabled: true,
    });

    const tool = createActivateSkillTool(new SkillLoader(root, undefined, 'external'));
    const output = normalizeRuntimeToolResult(await tool.handler({ id: 'remote-review' }, {
      workspace: root,
      contentManager: new ContentManager(),
    }));

    assert.deepEqual(output.context, []);
    assert.equal('instructions' in output.publicOutput, false);
    assert.match(JSON.stringify(output.modelOutput), /Remote workflow/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
