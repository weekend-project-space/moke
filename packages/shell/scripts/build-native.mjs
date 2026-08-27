import { spawnSync } from 'node:child_process';

const target = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : null;
if (!target) {
  console.error(`No native sandbox helper is available for ${process.platform}`);
  process.exit(1);
}

const result = spawnSync('npm', ['run', `build:native:${target}`], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
