"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DialogWindow = void 0;
exports.statusChipFor = statusChipFor;
const electron_1 = require("electron");
const types_1 = require("../../shared/types");
const paths_1 = require("./paths");
/** Dialog status chip for an agent state (spec section 9 status line). */
function statusChipFor(state) {
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
class DialogWindow {
    win;
    logger;
    options;
    hotkey;
    messages = [];
    submitListener;
    escListener;
    hideListener;
    readyListener;
    ackListener;
    timer = null;
    lastAck = 0;
    state = 'Idle';
    hint = '';
    panelOpen = false;
    ready = false;
    destroyed = false;
    dead = false;
    constructor(options) {
        this.options = options;
        this.logger = options.logger;
        this.hotkey = options.hotkey ?? 'Control+Shift+G';
        const display = electron_1.screen.getPrimaryDisplay();
        this.win = new electron_1.BrowserWindow({
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
                preload: (0, paths_1.preloadPath)(),
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
        void this.win.loadFile((0, paths_1.dialogHtmlPath)()).catch((error) => {
            this.logger.error('system', 'dialog failed to load', { error: String(error) });
            this.markDead('dialog failed to load');
        });
        const mine = (event) => !this.destroyed && !this.win.isDestroyed() && event.sender.id === this.win.webContents.id;
        this.submitListener = (event, payload) => {
            if (!mine(event))
                return;
            const text = payload?.text;
            if (typeof text === 'string' && text.trim().length > 0)
                this.options.onSubmit(text);
        };
        this.escListener = (event) => {
            if (!mine(event))
                return;
            this.options.onEsc();
        };
        this.hideListener = (event) => {
            if (!mine(event))
                return;
            this.close();
            this.options.onHide?.();
        };
        this.readyListener = (event) => {
            if (!mine(event))
                return;
            this.ready = true;
            this.lastAck = Date.now();
            this.pushStatus();
            for (const message of this.messages)
                this.pushMessage(message);
        };
        this.ackListener = (event) => {
            if (!mine(event))
                return;
            this.lastAck = Date.now();
            if (this.dead) {
                this.dead = false;
                this.logger.info('heartbeat', 'dialog overlay heartbeat recovered');
            }
        };
    }
    /** Register IPC listeners, the heartbeat and the global hotkey. */
    start() {
        electron_1.ipcMain.on(types_1.IPC.dialogSubmit, this.submitListener);
        electron_1.ipcMain.on(types_1.IPC.dialogEsc, this.escListener);
        electron_1.ipcMain.on(types_1.IPC.dialogHide, this.hideListener);
        electron_1.ipcMain.on(types_1.IPC.dialogReady, this.readyListener);
        electron_1.ipcMain.on(types_1.IPC.ghostHeartbeatAck, this.ackListener);
        this.lastAck = Date.now();
        this.timer = setInterval(() => {
            if (this.destroyed || this.win.isDestroyed()) {
                this.markDead('dialog window destroyed');
                return;
            }
            try {
                this.win.webContents.send(types_1.IPC.ghostHeartbeat, Date.now());
            }
            catch (error) {
                this.markDead(`dialog send failed: ${String(error)}`);
                return;
            }
            if (Date.now() - this.lastAck > types_1.HEARTBEAT_TIMEOUT_MS) {
                this.markDead('dialog heartbeat timed out');
            }
        }, types_1.HEARTBEAT_INTERVAL_MS);
        const registered = electron_1.globalShortcut.register(this.hotkey, () => this.toggle());
        this.logger.info('system', 'dialog overlay started', {
            hotkey: this.hotkey,
            registered,
            intervalMs: types_1.HEARTBEAT_INTERVAL_MS,
        });
        if (!registered) {
            this.say(`The hotkey ${this.hotkey} is already used by another app; the panel still works.`);
        }
    }
    markDead(reason) {
        if (this.dead)
            return;
        this.dead = true;
        this.logger.error('heartbeat', `dialog overlay lost: ${reason}`, { reason });
    }
    get alive() {
        return !this.dead && !this.destroyed && !this.win.isDestroyed();
    }
    get isOpen() {
        return this.panelOpen;
    }
    get currentHotkey() {
        return this.hotkey;
    }
    toggle() {
        if (this.panelOpen)
            this.close();
        else
            this.open();
    }
    open() {
        if (this.destroyed || this.win.isDestroyed())
            return;
        this.panelOpen = true;
        this.win.show();
        this.win.focus();
        this.pushStatus();
        this.focusInput();
    }
    close() {
        this.panelOpen = false;
        if (!this.destroyed && !this.win.isDestroyed())
            this.win.hide();
    }
    /** A ghost message in the transcript. */
    say(text) {
        this.pushMessage({ from: 'ghost', text, at: Date.now() });
    }
    /** The user's own message, echoed before anything happens. */
    echoUser(text) {
        this.pushMessage({ from: 'user', text, at: Date.now() });
    }
    setStatus(state, hint) {
        this.state = state;
        if (hint !== undefined)
            this.hint = hint;
        this.pushStatus();
    }
    focusInput() {
        if (this.destroyed || this.win.isDestroyed() || !this.ready)
            return;
        try {
            this.win.webContents.send(types_1.IPC.dialogFocusInput);
        }
        catch {
            // Not fatal: the panel is still usable with the mouse.
        }
    }
    pushMessage(message) {
        this.messages.push(message);
        while (this.messages.length > MAX_MESSAGES)
            this.messages.shift();
        if (this.destroyed || this.win.isDestroyed() || !this.ready)
            return;
        try {
            this.win.webContents.send(types_1.IPC.dialogMessage, message);
        }
        catch (error) {
            this.markDead(`dialog send failed: ${String(error)}`);
        }
    }
    pushStatus() {
        if (this.destroyed || this.win.isDestroyed() || !this.ready)
            return;
        try {
            this.win.webContents.send(types_1.IPC.dialogStatus, {
                chip: statusChipFor(this.state),
                state: this.state,
                hint: this.hint,
                hotkey: this.hotkey,
                open: this.panelOpen,
            });
        }
        catch (error) {
            this.markDead(`dialog send failed: ${String(error)}`);
        }
    }
    destroy() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        electron_1.globalShortcut.unregister(this.hotkey);
        electron_1.ipcMain.removeListener(types_1.IPC.dialogSubmit, this.submitListener);
        electron_1.ipcMain.removeListener(types_1.IPC.dialogEsc, this.escListener);
        electron_1.ipcMain.removeListener(types_1.IPC.dialogHide, this.hideListener);
        electron_1.ipcMain.removeListener(types_1.IPC.dialogReady, this.readyListener);
        electron_1.ipcMain.removeListener(types_1.IPC.ghostHeartbeatAck, this.ackListener);
        if (!this.destroyed && !this.win.isDestroyed())
            this.win.destroy();
        this.destroyed = true;
    }
}
exports.DialogWindow = DialogWindow;
//# sourceMappingURL=dialogWindow.js.map