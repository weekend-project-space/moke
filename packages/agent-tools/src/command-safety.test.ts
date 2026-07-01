import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { analyzeCommandSafety } from './command-safety.js';

const workspace = path.resolve('E:/work/test/moke');

function analyze(commandText: string, approvedRoots = [workspace], cwd = workspace) {
  return analyzeCommandSafety({
    commandText,
    cwd,
    approvedRoots,
  }).issues;
}

test('analyzeCommandSafety allows URLs', () => {
  assert.deepEqual(analyze('curl https://example.com/a/b'), []);
});

test('analyzeCommandSafety rejects quoted absolute paths outside approved roots', () => {
  const issues = analyze('type "E:\\notes\\a.md"');

  assert.equal(issues[0]?.code, 'absolute_path_outside_workspace');
  assert.equal(issues[0]?.path, path.resolve('E:/notes/a.md'));
});

test('analyzeCommandSafety allows absolute paths inside approved roots', () => {
  assert.deepEqual(analyze('type "E:\\notes\\a.md"', [workspace, path.resolve('E:/notes')]), []);
});

test('analyzeCommandSafety rejects relative paths that escape cwd', () => {
  const issues = analyze('type ..\\a.md');

  assert.equal(issues[0]?.code, 'relative_path_escapes_workspace');
  assert.equal(issues[0]?.path, path.resolve('E:/work/test/a.md'));
});

test('analyzeCommandSafety allows relative paths that stay in workspace', () => {
  assert.deepEqual(analyze('type ..\\..\\package.json', [workspace], path.resolve('E:/work/test/moke/apps/server')), []);
});

test('analyzeCommandSafety rejects redirection targets outside workspace', () => {
  const issues = analyze('echo hello > ..\\a.md');

  assert.equal(issues.some((issue) => issue.code === 'redirection_target_escapes_workspace'), true);
});
