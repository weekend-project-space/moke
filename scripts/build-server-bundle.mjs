import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const resourcesDir = join(root, 'apps/client/src-tauri/resources');
const outputDir = join(resourcesDir, 'server');
const shellOutputDir = join(resourcesDir, 'shell');

rmSync(outputDir, { recursive: true, force: true });
rmSync(shellOutputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
mkdirSync(shellOutputDir, { recursive: true });

if (process.platform === 'win32') {
  const manifestPath = join(root, 'packages/shell/native/windows-sandbox/Cargo.toml');
  const result = spawnSync('cargo', ['build', '--release', '--manifest-path', manifestPath], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows sandbox helper build failed with exit code ${result.status}`);
  copyFileSync(
    join(root, 'packages/shell/native/windows-sandbox/target/release/moke-windows-sandbox.exe'),
    join(shellOutputDir, 'moke-windows-sandbox.exe'),
  );
}

await build({
  entryPoints: [join(root, 'apps/server/server.ts')],
  outfile: join(outputDir, 'server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: false,
  logLevel: 'info',
});

copyFileSync(process.execPath, join(outputDir, basename(process.execPath)));
