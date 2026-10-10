import { BrowserWindow, ipcMain, screen } from 'electron';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, IPC } from '../../shared/types';
import type { GhostCommand } from '../../shared/types';
import type { Logger } from '../logger';
import { screenToOverlayLocal } from '../browser/coordinates';
import { overlayHtmlPath, preloadPath } from './paths';

/**
 * Ghost overlay (spec section 9).
 *
 * A transparent, frameless, always-on-top, click-through window spanning the
 * display. It never takes focus and never accepts clicks, so the user's real
 * mouse keeps working exactly as before (spec section 2, rule 1: no OS-level
 * input). Everything the ghost does is drawn here: the cursor, its arc, the
 * target ring and the hint text.
 */

export interface OverlayWindowOptions {
  logger: Logger;
  /** Called when the overlay stops answering: the agent must halt. */
  onDead?: () => void;
  onAlive?: () => void;
}

export class OverlayWindow {
  private readonly win: BrowserWindow;
  private readonly logger: Logger;
  private readonly onDead?: () => void;
  private readonly onAlive?: () => void;
  private readonly ackListener: (event: Electron.IpcMainEvent) => void;
  private readonly readyListener: (event: Electron.IpcMainEvent) => void;
  private timer: NodeJS.Timeout | null = null;
  private lastAck = 0;
  private ready = false;
  private destroyed = false;
  private dead = false;

  constructor(options: OverlayWindowOptions) {
    this.logger = options.logger;
    this.onDead = options.onDead;
    this.onAlive = options.onAlive;

    const display = screen.getPrimaryDisplay();
    this.win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Click-through: the user's mouse always reaches the real page.
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.once('ready-to-show', () => {
      this.ready = true;
      this.lastAck = Date.now();
      this.win.showInactive();
    });
    this.win.on('closed', () => {
      this.destroyed = true;
      this.markDead('overlay window closed');
    });
    void this.win.loadFile(overlayHtmlPath()).catch((error: unknown) => {
      this.logger.error('system', 'overlay failed to load', { error: String(error) });
      this.markDead('overlay failed to load');
    });

    this.ackListener = (event): void => {
      if (event.sender.id !== this.win.webContents.id) return;
      this.lastAck = Date.now();
      if (this.dead) {
        this.dead = false;
        this.logger.info('heartbeat', 'ghost overlay heartbeat recovered');
        this.onAlive?.();
      }
    };
    this.readyListener = (event): void => {
      if (event.sender.id !== this.win.webContents.id) return;
      this.ready = true;
      this.lastAck = Date.now();
    };
  }

  /** Start the heartbeat (spec section 10: halt when an overlay stops answering). */
  start(): void {
    ipcMain.on(IPC.ghostHeartbeatAck, this.ackListener);
    ipcMain.on(IPC.ghostReady, this.readyListener);
    this.lastAck = Date.now();
    this.timer = setInterval(() => {
      if (this.destroyed || this.win.isDestroyed()) {
        this.markDead('overlay window destroyed');
        return;
      }
      try {
        this.win.webContents.send(IPC.ghostHeartbeat, Date.now());
      } catch (error) {
        this.markDead(`overlay send failed: ${String(error)}`);
        return;
      }
      if (Date.now() - this.lastAck > HEARTBEAT_TIMEOUT_MS) {
        this.markDead('overlay heartbeat timed out');
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.logger.info('heartbeat', 'ghost overlay heartbeat started', {
      intervalMs: HEARTBEAT_INTERVAL_MS,
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
    });
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.logger.error('heartbeat', `ghost overlay lost: ${reason}`, { reason });
    this.onDead?.();
  }

  get alive(): boolean {
    return !this.dead && !this.destroyed && !this.win.isDestroyed();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get window(): BrowserWindow {
    return this.win;
  }

  /** Send one ghost command to the overlay renderer. */
  send(command: GhostCommand): void {
    if (this.destroyed || this.win.isDestroyed() || !this.ready) return;
    try {
      this.win.webContents.send(IPC.ghostCommand, command);
    } catch (error) {
      this.markDead(`overlay send failed: ${String(error)}`);
    }
  }

  /** Move the ghost cursor to an absolute screen DIP position. */
  move(x: number, y: number, durationMs: number, hint?: string): void {
    const local = screenToOverlayLocal(screen.getPrimaryDisplay().bounds, { x, y });
    this.send({ kind: 'move', x: local.x, y: local.y, durationMs, hint });
  }

  pulse(): void {
    this.send({ kind: 'pulse' });
  }

  ripple(): void {
    this.send({ kind: 'ripple' });
  }

  hint(text: string): void {
    this.send({ kind: 'hint', text });
  }

  thinking(on: boolean): void {
    this.send({ kind: 'thinking', on });
  }

  hide(): void {
    this.send({ kind: 'hide' });
  }

  /** Target is off screen: point toward it from the display edge and hint. */
  offscreen(x: number, y: number, hint: string): void {
    const local = screenToOverlayLocal(screen.getPrimaryDisplay().bounds, { x, y });
    this.send({ kind: 'offscreen', x: local.x, y: local.y, hint });
  }

  /** Follow a display change (v1 keeps the primary display). */
  resizeToPrimaryDisplay(): void {
    if (this.destroyed || this.win.isDestroyed()) return;
    this.win.setBounds(screen.getPrimaryDisplay().bounds);
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    ipcMain.removeListener(IPC.ghostHeartbeatAck, this.ackListener);
    ipcMain.removeListener(IPC.ghostReady, this.readyListener);
    if (!this.destroyed && !this.win.isDestroyed()) this.win.destroy();
    this.destroyed = true;
  }
}

