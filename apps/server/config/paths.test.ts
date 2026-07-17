import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { normalizeWindowsDrivePath, resolveEnvPaths, resolvePath, resolvePort } from './paths.js';

test('resolvePort falls back for invalid values', () => {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(resolvePort(undefined), 4010);
    assert.equal(resolvePort('abc'), 4010);
    assert.equal(resolvePort('0'), 4010);
    assert.equal(resolvePort('70000'), 4010);
    assert.equal(resolvePort('4020'), 4020);
  } finally {
    console.warn = originalWarn;
  }
});

test('resolvePath resolves relative values from the supplied base path', () => {
  assert.equal(
    resolvePath('.moke/state.json', 'E:\\work\\test\\moke', '.moke/fallback.json'),
    resolve('E:\\work\\test\\moke', '.moke/state.json'),
  );
});

test('resolvePath uses fallback when the input is empty', () => {
  assert.equal(
    resolvePath('', 'E:\\work\\test\\moke', '.moke/state.json'),
    resolve('E:\\work\\test\\moke', '.moke/state.json'),
  );
});

test('normalizeWindowsDrivePath removes a leading slash before a drive path', { skip: process.platform !== 'win32' }, () => {
  assert.equal(normalizeWindowsDrivePath('\\E:\\work\\test\\moke\\.moke\\state.json'), 'E:\\work\\test\\moke\\.moke\\state.json');
  assert.equal(normalizeWindowsDrivePath('/E:/work/test/moke/.moke/state.json'), 'E:/work/test/moke/.moke/state.json');
});

test('resolveEnvPaths includes explicit env path before workspace env file', () => {
  const previousEnvPath = process.env.MOKE_ENV_PATH;
  try {
    process.env.MOKE_ENV_PATH = '.moke/.env';
    assert.deepEqual(resolveEnvPaths('E:\\work\\test\\moke'), [
      resolve('E:\\work\\test\\moke', '.moke/.env'),
      resolve('E:\\work\\test\\moke', '.env'),
    ]);
  } finally {
    if (previousEnvPath === undefined) delete process.env.MOKE_ENV_PATH;
    else process.env.MOKE_ENV_PATH = previousEnvPath;
  }
});

test('resolveServerConfig includes permissions path under workspace', async () => {
  const { resolveServerConfig } = await import(`./paths.js?permissions-test=${Date.now()}`);
  const previousWorkspace = process.env.MOKE_WORKSPACE;
  const previousPermissionsPath = process.env.MOKE_PERMISSIONS_PATH;

  try {
    process.env.MOKE_WORKSPACE = 'E:\\work\\test\\moke';
    delete process.env.MOKE_PERMISSIONS_PATH;

    assert.equal(
      resolveServerConfig().permissionsPath,
      resolve('E:\\work\\test\\moke', '.moke', 'permissions.json'),
    );
  } finally {
    if (previousWorkspace === undefined) delete process.env.MOKE_WORKSPACE;
    else process.env.MOKE_WORKSPACE = previousWorkspace;
    if (previousPermissionsPath === undefined) delete process.env.MOKE_PERMISSIONS_PATH;
    else process.env.MOKE_PERMISSIONS_PATH = previousPermissionsPath;
  }
});

test('resolveServerConfig places the session store under workspace', async () => {
  const { resolveServerConfig } = await import(`./paths.js?store-test=${Date.now()}`);
  const previousWorkspace = process.env.MOKE_WORKSPACE;
  const previousStorePath = process.env.MOKE_STORE_PATH;

  try {
    process.env.MOKE_WORKSPACE = 'E:\\work\\test\\moke';
    delete process.env.MOKE_STORE_PATH;
    assert.equal(
      resolveServerConfig().storePath,
      resolve('E:\\work\\test\\moke', '.moke', 'store'),
    );
  } finally {
    if (previousWorkspace === undefined) delete process.env.MOKE_WORKSPACE;
    else process.env.MOKE_WORKSPACE = previousWorkspace;
    if (previousStorePath === undefined) delete process.env.MOKE_STORE_PATH;
    else process.env.MOKE_STORE_PATH = previousStorePath;
  }
});
