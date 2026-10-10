/**
 * Ghost overlay (spec 6.2): a separate transparent, frameless, click-through,
 * always-on-top window whose bounds always equal the main window's content
 * bounds. It only receives OverlayCommand over IPC. Heartbeat every 2 s; if the
 * overlay stops answering, the agent halts (rule 2).
 */
import { BrowserWindow, ipcMain, type BaseWindow } from 'electron';
import { IPC, type OverlayCommand } from '../shared/ipc';
import type { GhostPort, LoggerPort } from '../agent/types';
import { preloadPath, rendererEntry } from './paths';

const PING_MS = 2000;
const DEAD_AFTER_MS = 5000;

export class OverlayWindow implements GhostPort {
  readonly win: BrowserWindow;
  private lastPong = Date.now();
  private ready = false;
  private dead = false;
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;

  constructor(
    private readonly parent: BaseWindow,
    private readonly logger: LoggerPort,
    private readonly onDead: () => void,
  ) {
    const b = parent.getContentBounds();
    this.win = new BrowserWindow({
      ...b,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath('ghost'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setIgnoreMouseEvents(true);
    void rendererEntry(this.win.webContents, 'ghost');
    this.win.once('ready-to-show', () => {
      this.ready = true;
      this.lastPong = Date.now();
      this.win.showInactive();
    });
    this.win.on('closed', () => this.markDead('overlay window closed'));
    this.win.webContents.on('did-finish-load', () => {
      this.logger.info('overlay', 'loaded');
      // ready-to-show is unreliable for transparent, never-focused windows: show on load too.
      this.ready = true;
      this.lastPong = Date.now();
      this.ensureVisible();
    });
    this.win.webContents.on('did-fail-load', (_e, code, desc) => this.logger.error('overlay', 'load failed', { code, desc }));
    this.win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) this.logger.warn('overlay', 'console', { message: String(message).slice(0, 300) });
    });
    this.win.webContents.on('render-process-gone', (_e, details) => this.logger.error('overlay', 'renderer gone', { reason: details.reason }));

    const sync = (): void => this.syncBounds();
    for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'restore'] as const) parent.on(event as 'move', sync);
    parent.on('minimize', () => this.win.isDestroyed() || this.win.hide());
    // Whenever the main window comes back (restore, maximize, focus, show), bring the ghost back too.
    for (const event of ['restore', 'maximize', 'focus', 'show'] as const) {
      parent.on(event as 'restore', () => this.ensureVisible());
    }

    ipcMain.on(IPC.overlayPong, (event) => {
      if (!this.win.isDestroyed() && event.sender.id === this.win.webContents.id) {
        this.lastPong = Date.now();
        this.ready = true;
        if (this.dead && !this.win.isDestroyed()) {
          this.dead = false;
          this.logger.info('overlay', 'heartbeat recovered');
        }
      }
    });
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.win.isDestroyed()) return this.markDead('overlay destroyed');
      if (this.parent.isMinimized()) {
        this.lastPong = Date.now();
        return;
      }
      this.ensureVisible();
      this.win.webContents.send(IPC.overlayPing, Date.now());
      this.ticks += 1;
      if (this.ticks % 5 === 1) {
        this.logger.info('overlay', 'state', {
          visible: this.win.isVisible(),
          minimized: this.win.isMinimized(),
          ready: this.ready,
          dead: this.dead,
          pongAgeMs: Date.now() - this.lastPong,
          bounds: this.win.getBounds(),
          parent: this.parent.getContentBounds(),
        });
      }
      const silentMs = Date.now() - this.lastPong;
      if (silentMs > DEAD_AFTER_MS) {
        this.markDead(
          `overlay heartbeat timed out (silent ${silentMs} ms, visible=${this.win.isVisible()}, crashed=${this.win.webContents.isCrashed()})`,
        );
      }
    }, PING_MS);
  }

  syncBounds(): void {
    if (this.win.isDestroyed() || this.parent.isDestroyed()) return;
    this.win.setBounds(this.parent.getContentBounds());
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.logger.error('overlay', reason);
    this.onDead();
    // Try to recover for the NEXT task: a fresh pong clears `dead`.
    if (!this.win.isDestroyed()) this.win.webContents.reload();
  }

  /** Re-show the overlay (on top, click-through) if the main window is visible. */
  ensureVisible(): void {
    if (this.win.isDestroyed() || this.parent.isDestroyed()) return;
    if (this.parent.isMinimized() || !this.parent.isVisible()) return;
    this.syncBounds();
    if (this.win.isMinimized()) this.win.restore();
    if (!this.win.isVisible()) this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setIgnoreMouseEvents(true);
  }

  /** Rule 2: the agent may act only while the ghost can actually be seen. */
  get alive(): boolean {
    if (this.dead || this.win.isDestroyed() || !this.ready) return false;
    if (!this.win.isVisible()) this.ensureVisible();
    return this.win.isVisible();
  }

  private send(command: OverlayCommand): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(IPC.overlayCommand, command);
  }

  move(x: number, y: number, ms: number): void {
    this.send({ t: 'move', x, y, ms });
  }
  pulse(x: number, y: number): void {
    this.send({ t: 'pulse', x, y });
  }
  ripple(x: number, y: number): void {
    this.send({ t: 'ripple', x, y });
  }
  hint(text: string, x: number, y: number): void {
    this.send({ t: 'hint', text, x, y });
  }
  hide(): void {
    this.send({ t: 'hide' });
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.dead = true;
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}
