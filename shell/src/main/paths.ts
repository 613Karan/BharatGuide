import { join } from 'node:path';
import type { WebContents } from 'electron';

export type Page = 'chat' | 'toolbar' | 'ghost';

export function preloadPath(page: Page): string {
  return join(__dirname, '../preload', `${page}.js`);
}

/** Load a bundled renderer page (dev server URL in `electron-vite dev`). */
export function rendererEntry(wc: WebContents, page: Page): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) return wc.loadURL(`${devUrl}/${page}/index.html`);
  return wc.loadFile(join(__dirname, '../renderer', page, 'index.html'));
}

/** Local renderers may only ever show bundled files. */
export function isLocalRendererUrl(url: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return url.startsWith('file://') || (devUrl ? url.startsWith(devUrl) : false);
}
