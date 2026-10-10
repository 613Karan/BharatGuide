/**
 * Copies the renderer assets (HTML/CSS/JS + preload) into dist/renderer.
 *
 * TypeScript only compiles .ts, and the transparent windows load plain files
 * through file:// (see src/main/ui/paths.ts), so these assets are copied as-is.
 * Run via `npm run assets`, which `npm run build` already chains after tsc.
 */
import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const sourceDir = join(projectRoot, 'src', 'renderer');
const targetDir = join(projectRoot, 'dist', 'renderer');

const EXTENSIONS = new Set(['.html', '.css', '.js']);

if (!existsSync(sourceDir)) {
  console.error(`copy-assets: source directory is missing: ${sourceDir}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const dot = entry.name.lastIndexOf('.');
  const extension = dot >= 0 ? entry.name.slice(dot).toLowerCase() : '';
  if (!EXTENSIONS.has(extension)) continue;
  copyFileSync(join(sourceDir, entry.name), join(targetDir, entry.name));
  copied += 1;
  console.log(`copy-assets: ${entry.name}`);
}

if (copied === 0) {
  console.error('copy-assets: nothing was copied - check src/renderer');
  process.exit(1);
}

console.log(`copy-assets: ${copied} file(s) -> ${targetDir}`);
