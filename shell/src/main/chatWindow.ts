/**
 * Floating assistant panel (UI option a): a small frameless dark window pinned
 * to the top-right of the main window, over the page. It is a CHILD window of
 * the main window (stays above it, not above other apps). The ghost overlay
 * (always-on-top, screen-saver level) still draws above it.
 */
import { BrowserWindow, type BaseWindow } from 'electron';
import { TOOLBAR_HEIGHT } from './views';
import { isLocalRendererUrl, preloadPath, rendererEntry } from './paths';

export const PANEL_WIDTH = 400;
export const PANEL_HEIGHT = 580;
export const PANEL_COLLAPSED_HEIGHT = 52;
const MARGIN = 14;

export class ChatWindow {
  readonly win: BrowserWindow;
  private collapsed = false;

  constructor(private readonly parent: BaseWindow) {
    this.win = new BrowserWindow({
      parent,
      ...this.bounds(),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath('chat'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    const wc = this.win.webContents;
    wc.on('will-navigate', (event, url) => {
      if (!isLocalRendererUrl(url)) event.preventDefault();
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    void rendererEntry(wc, 'chat');
    this.win.once('ready-to-show', () => this.win.show());

    const sync = (): void => this.sync();
    for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'restore'] as const) parent.on(event as 'move', sync);
  }

  private bounds() {
    const c = this.parent.getContentBounds();
    const height = this.collapsed ? PANEL_COLLAPSED_HEIGHT : Math.min(PANEL_HEIGHT, c.height - TOOLBAR_HEIGHT - MARGIN * 2);
    return {
      x: Math.round(c.x + c.width - PANEL_WIDTH - MARGIN),
      y: Math.round(c.y + TOOLBAR_HEIGHT + MARGIN),
      width: PANEL_WIDTH,
      height: Math.max(PANEL_COLLAPSED_HEIGHT, height),
    };
  }

  sync(): void {
    if (!this.win.isDestroyed() && !this.parent.isDestroyed()) this.win.setBounds(this.bounds());
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.sync();
  }

  /** Overlay-local rect of the panel (ghost avoids nothing, but the agent may need it). */
  focusInput(): void {
    if (this.collapsed) this.setCollapsed(false);
    this.win.focus();
  }

  destroy(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}
