/**
 * Main window layout (spec 6.1): toolbar view on top (~84 px), active page view
 * below-left, chat view on the right (~380 px). Every local renderer is
 * sandboxed, context-isolated, has its own minimal preload, and may only load
 * bundled files.
 */
import { BaseWindow, WebContentsView, shell as electronShell } from 'electron';
import { isLocalRendererUrl, preloadPath, rendererEntry, type Page } from './paths';

export const TOOLBAR_HEIGHT = 84;
export const CHAT_WIDTH = 380;

export type Rect = { x: number; y: number; width: number; height: number };

/** Page takes the full width; the assistant floats top-right in its own window. */
export function computeLayout(contentWidth: number, contentHeight: number) {
  return {
    toolbar: { x: 0, y: 0, width: contentWidth, height: TOOLBAR_HEIGHT },
    page: { x: 0, y: TOOLBAR_HEIGHT, width: contentWidth, height: Math.max(100, contentHeight - TOOLBAR_HEIGHT) },
  };
}

export function createLocalView(page: Page): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: preloadPath(page),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const wc = view.webContents;
  // Local renderers never navigate away or open windows.
  wc.on('will-navigate', (event, url) => {
    if (!isLocalRendererUrl(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  void rendererEntry(wc, page);
  return view;
}

export function createMainWindow(): BaseWindow {
  return new BaseWindow({
    width: 1400,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    title: 'Guided Government-Services Assistant',
    backgroundColor: '#0b0d14',
    show: true,
  });
}

/** Unused by design; kept so no code path ever opens external windows by accident. */
export const neverOpenExternal = (): void => void electronShell;
