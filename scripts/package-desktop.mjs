import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const installerDir = join(root, 'apps/client/src-tauri/target/release/bundle/nsis');
const installerPath = join(installerDir, 'Moke_0.1.0_x64-setup.exe');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function backupPreviousInstaller() {
  if (!existsSync(installerPath)) return;

  mkdirSync(installerDir, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');
  const backupPath = join(installerDir, `Moke_0.1.0_x64-setup.${timestamp}.exe`);

  try {
    renameSync(installerPath, backupPath);
    console.log(`Backed up previous installer: ${backupPath}`);
  } catch (error) {
    console.warn(`Could not rename previous installer. It may be open or locked: ${installerPath}`);
    console.warn(error instanceof Error ? error.message : String(error));
  }
}

backupPreviousInstaller();
const tauriBuildArgs = ['--prefix', 'apps/client', 'run', 'tauri', 'build', '--', '--bundles', 'nsis'];
if (process.platform === 'win32') {
  run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...tauriBuildArgs]);
} else {
  run('npm', tauriBuildArgs);
}

if (!existsSync(installerPath)) {
  console.error(`Installer was not created: ${installerPath}`);
  process.exit(1);
}

const sizeMb = (statSync(installerPath).size / 1024 / 1024).toFixed(1);
console.log(`Desktop installer ready: ${installerPath} (${sizeMb} MB)`);
