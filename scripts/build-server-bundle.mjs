import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const outputDir = join(root, 'apps/client/src-tauri/resources/server');

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

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
