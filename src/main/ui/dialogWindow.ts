import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  IPC,
} from '../../shared/types';
import type { AgentState, DialogMessage, StatusChip } from '../../shared/types';
import type { Logger } from '../logger';
import { dialogHtmlPath, preloadPath } from './paths';

/**
 * Dialog overlay (spec section 9).
 *
 * Small always-on-top panel with the hotkey, the message list and one input
 * field. Opening it never changes the agent state; a submitted message becomes an
 * intent that still has to pass the single validation door (guardrails.ts).
 */

export interface DialogWindowOptions {
  logger: Logger;
  hotkey?: string;
  /** A user message was submitted. The agent core classifies it. */
  onSubmit: (text: string) => void;
  /** Escape inside the dialog, or Escape reported by the page listener. */
  onEsc: () => void;
  onHide?: () => void;
}

/** Dialog status chip for an agent state (spec section 9 status line). */
export function statusChipFor(state: AgentState): StatusChip {
  switch (state) {
    case 'RunningCommand':
      return 'Running command';
    case 'Halted':
      return 'Halted';
    case 'Guiding':
    case 'AwaitingUser':
      return 'Guiding';
    default:
      return 'Idle';
  }
}

const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 470;
const MAX_MESSAGES = 60;

export class DialogWindow {
  private readonly win: BrowserWindow;
  private readonly logger: Logger;
  private readonly options: DialogWindowOptions;
  private readonly hotkey: string;
  private readonly messages: DialogMessage[] = [];
  private readonly submitListener: (event: Electron.IpcMainEvent, payload: unknown) => void;
  private readonly escListener: (event: Electron.IpcMainEvent) => void;
  private readonly hideListener: (event: Electron.IpcMainEvent) => void;
  private readonly readyListener: (event: Electron.IpcMainEvent) => void;
  private readonly ackListener: (event: Electron.IpcMainEvent) => void;
  private timer: NodeJS.Timeout | null = null;
  private lastAck = 0;
  private state: AgentState = 'Idle';
  private hint = '';
  private panelOpen = false;
  private ready = false;
  private destroyed = false;
  private dead = false;

  constructor(options: DialogWindowOptions) {
    this.options = options;
    this.logger = options.logger;
    this.hotkey = options.hotkey ?? 'Control+Shift+G';

    const display = screen.getPrimaryDisplay();
    this.win = new BrowserWindow({
      x: display.workArea.x + display.workArea.width - PANEL_WIDTH - 24,
      y: display.workArea.y + 24,
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
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
    this.win.once('ready-to-show', () => {
      this.ready = true;
      this.lastAck = Date.now();
      this.pushStatus();
    });
    this.win.on('closed', () => {
      this.destroyed = true;
      this.markDead('dialog window closed');
    });
    void this.win.loadFile(dialogHtmlPath()).catch((error: unknown) => {
      this.logger.error('system', 'dialog failed to load', { error: String(error) });
      this.markDead('dialog failed to load');
    });

    const mine = (event: Electron.IpcMainEvent): boolean =>
      !this.destroyed && !this.win.isDestroyed() && event.sender.id === this.win.webContents.id;

    this.submitListener = (event, payload): void => {
      if (!mine(event)) return;
      const text = (payload as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && text.trim().length > 0) this.options.onSubmit(text);
    };
    this.escListener = (event): void => {
      if (!mine(event)) return;
      this.options.onEsc();
    };
    this.hideListener = (event): void => {
      if (!mine(event)) return;
      this.close();
      this.options.onHide?.();
    };
    this.readyListener = (event): void => {
      if (!mine(event)) return;
      this.ready = true;
      this.lastAck = Date.now();
      this.pushStatus();
      for (const message of this.messages) this.pushMessage(message);
    };
    this.ackListener = (event): void => {
      if (!mine(event)) return;
      this.lastAck = Date.now();
      if (this.dead) {
        this.dead = false;
        this.logger.info('heartbeat', 'dialog overlay heartbeat recovered');
      }
    };
  }

  /** Register IPC listeners, the heartbeat and the global hotkey. */
  start(): void {
    ipcMain.on(IPC.dialogSubmit, this.submitListener);
    ipcMain.on(IPC.dialogEsc, this.escListener);
    ipcMain.on(IPC.dialogHide, this.hideListener);
    ipcMain.on(IPC.dialogReady, this.readyListener);
    ipcMain.on(IPC.ghostHeartbeatAck, this.ackListener);
    this.lastAck = Date.now();
    this.timer = setInterval(() => {
      if (this.destroyed || this.win.isDestroyed()) {
        this.markDead('dialog window destroyed');
        return;
      }
      try {
        this.win.webContents.send(IPC.ghostHeartbeat, Date.now());
      } catch (error) {
        this.markDead(`dialog send failed: ${String(error)}`);
        return;
      }
      if (Date.now() - this.lastAck > HEARTBEAT_TIMEOUT_MS) {
        this.markDead('dialog heartbeat timed out');
      }
    }, HEARTBEAT_INTERVAL_MS);

    const registered = globalShortcut.register(this.hotkey, () => this.toggle());
    this.logger.info('system', 'dialog overlay started', {
      hotkey: this.hotkey,
      registered,
      intervalMs: HEARTBEAT_INTERVAL_MS,
    });
    if (!registered) {
      this.say(`The hotkey ${this.hotkey} is already used by another app; the panel still works.`);
    }
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.logger.error('heartbeat', `dialog overlay lost: ${reason}`, { reason });
  }

  get alive(): boolean {
    return !this.dead && !this.destroyed && !this.win.isDestroyed();
  }

  get isOpen(): boolean {
    return this.panelOpen;
  }

  get currentHotkey(): string {
    return this.hotkey;
  }

  toggle(): void {
    if (this.panelOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.destroyed || this.win.isDestroyed()) return;
    this.panelOpen = true;
    this.win.show();
    this.win.focus();
    this.pushStatus();
    this.focusInput();
  }

  close(): void {
    this.panelOpen = false;
    if (!this.destroyed && !this.win.isDestroyed()) this.win.hide();
  }

  /** A ghost message in the transcript. */
  say(text: string): void {
    this.pushMessage({ from: 'ghost', text, at: Date.now() });
  }

  /** The user's own message, echoed before anything happens. */
  echoUser(text: string): void {
    this.pushMessage({ from: 'user', text, at: Date.now() });
  }

  setStatus(state: AgentState, hint?: string): void {
    this.state = state;
    if (hint !== undefined) this.hint = hint;
    this.pushStatus();
  }

  focusInput(): void {
    if (this.destroyed || this.win.isDestroyed() || !this.ready) return;
    try {
      this.win.webContents.send(IPC.dialogFocusInput);
    } catch {
      // Not fatal: the panel is still usable with the mouse.
    }
  }

  private pushMessage(message: DialogMessage): void {
    this.messages.push(message);
    while (this.messages.length > MAX_MESSAGES) this.messages.shift();
    if (this.destroyed || this.win.isDestroyed() || !this.ready) return;
    try {
      this.win.webContents.send(IPC.dialogMessage, message);
    } catch (error) {
      this.markDead(`dialog send failed: ${String(error)}`);
    }
  }

  private pushStatus(): void {
    if (this.destroyed || this.win.isDestroyed() || !this.ready) return;
    try {
      this.win.webContents.send(IPC.dialogStatus, {
        chip: statusChipFor(this.state),
        state: this.state,
        hint: this.hint,
        hotkey: this.hotkey,
        open: this.panelOpen,
      });
    } catch (error) {
      this.markDead(`dialog send failed: ${String(error)}`);
    }
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    globalShortcut.unregister(this.hotkey);
    ipcMain.removeListener(IPC.dialogSubmit, this.submitListener);
    ipcMain.removeListener(IPC.dialogEsc, this.escListener);
    ipcMain.removeListener(IPC.dialogHide, this.hideListener);
    ipcMain.removeListener(IPC.dialogReady, this.readyListener);
    ipcMain.removeListener(IPC.ghostHeartbeatAck, this.ackListener);
    if (!this.destroyed && !this.win.isDestroyed()) this.win.destroy();
    this.destroyed = true;
  }
}

