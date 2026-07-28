import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { analyzeCommandComplexity, analyzeCommandSafety, analyzePowerShellCompatibility } from './command-safety.js';

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

test('analyzeCommandSafety rejects working directory changes outside workspace', () => {
  const issues = analyze('cd ..; copy moke\\a.md a.md');

  assert.equal(issues[0]?.code, 'working_directory_escapes_workspace');
  assert.equal(issues[0]?.path, path.resolve('E:/work/test'));
});

test('analyzeCommandSafety allows working directory changes inside workspace', () => {
  assert.deepEqual(analyze('cd apps; npm test'), []);
});

test('analyzeCommandSafety rejects PowerShell environment variable paths outside approved roots', () => {
  process.env.MOKE_TEST_TEMP = path.resolve('E:/moke-temp');

  const issues = analyze('copy a.md $env:MOKE_TEST_TEMP\\a.md');

  assert.equal(issues[0]?.code, 'environment_path');
  assert.equal(issues[0]?.path, path.resolve('E:/moke-temp/a.md'));
});

test('analyzeCommandSafety allows environment variable paths inside approved roots', () => {
  process.env.MOKE_TEST_WORKSPACE = workspace;

  assert.deepEqual(analyze('copy a.md $env:MOKE_TEST_WORKSPACE\\a.md'), []);
});

test('analyzeCommandSafety rejects cmd environment variable paths outside approved roots', () => {
  process.env.MOKE_TEST_TEMP = path.resolve('E:/moke-temp');

  const issues = analyze('copy a.md %MOKE_TEST_TEMP%\\a.md');

  assert.equal(issues[0]?.code, 'environment_path');
  assert.equal(issues[0]?.path, path.resolve('E:/moke-temp/a.md'));
});

test('analyzeCommandSafety rejects home directory paths outside approved roots', () => {
  const issues = analyze('copy a.md ~\\a.md');

  assert.equal(issues[0]?.code, 'home_path');
});

test('analyzeCommandSafety rejects Join-Path roots outside approved roots', () => {
  const issues = analyze('copy a.md (Join-Path E:\\ a.md)');

  assert.equal(issues[0]?.code, 'dynamic_path');
  assert.equal(issues[0]?.path, path.resolve('E:/'));
});

test('analyzeCommandSafety rejects bare drive roots outside approved roots', () => {
  const issues = analyze('copy a.md E:\\');

  assert.equal(issues[0]?.code, 'absolute_path_outside_workspace');
  assert.equal(issues[0]?.path, path.resolve('E:/'));
});

test('analyzePowerShellCompatibility rejects cmd switches on PowerShell aliases', () => {
  const issues = analyzePowerShellCompatibility('del /q ".moke-browser-test\\manual-approval.txt"').issues;

  assert.equal(issues[0]?.command, 'del');
  assert.equal(issues[0]?.token, '/q');
});

test('analyzePowerShellCompatibility finds cmd switches after a command separator', () => {
  const issues = analyzePowerShellCompatibility('Write-Output ready; rmdir /s /q .cache').issues;

  assert.equal(issues[0]?.command, 'rmdir');
  assert.equal(issues[0]?.token, '/s');
});

test('analyzePowerShellCompatibility keeps Unix paths and PowerShell parameters valid', () => {
  assert.deepEqual(analyzePowerShellCompatibility('cat /etc/hosts').issues, []);
  assert.deepEqual(analyzePowerShellCompatibility('Remove-Item -LiteralPath file.txt -Force').issues, []);
  assert.deepEqual(analyzePowerShellCompatibility('attrib /s file.txt').issues, []);
});

test('analyzeCommandComplexity flags shell control operators', () => {
  const issues = analyzeCommandComplexity('npm test && npm run build').issues;

  assert.equal(issues[0]?.code, 'shell_control_operator');
});

test('analyzeCommandComplexity flags substitutions', () => {
  const issues = analyzeCommandComplexity('echo $(Get-Location)').issues;

  assert.equal(issues[0]?.code, 'substitution');
});

test('analyzeCommandComplexity flags encoded commands', () => {
  const issues = analyzeCommandComplexity('powershell -EncodedCommand AAAA').issues;

  assert.equal(issues[0]?.code, 'encoded_command');
});

test('analyzeCommandComplexity flags background processes', () => {
  const issues = analyzeCommandComplexity('Start-Process notepad').issues;

  assert.equal(issues[0]?.code, 'background_process');
});
