import * as path from 'node:path';
import { app } from 'electron';

/**
 * Where the compiled renderer files live.
 * In development: <project>/dist/renderer. Packaged: <resources>/renderer.
 */
export function rendererFile(name: string): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'renderer', name);
  return path.join(__dirname, '..', '..', 'renderer', name);
}

export function preloadPath(): string {
  return rendererFile('preload.js');
}

export function overlayHtmlPath(): string {
  return rendererFile('overlay.html');
}

export function dialogHtmlPath(): string {
  return rendererFile('dialog.html');
}
