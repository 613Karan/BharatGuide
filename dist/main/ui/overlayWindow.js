"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OverlayWindow = void 0;
const electron_1 = require("electron");
const types_1 = require("../../shared/types");
const coordinates_1 = require("../browser/coordinates");
const paths_1 = require("./paths");
class OverlayWindow {
    win;
    logger;
    onDead;
    onAlive;
    ackListener;
    readyListener;
    timer = null;
    lastAck = 0;
    ready = false;
    destroyed = false;
    dead = false;
    constructor(options) {
        this.logger = options.logger;
        this.onDead = options.onDead;
        this.onAlive = options.onAlive;
        const display = electron_1.screen.getPrimaryDisplay();
        this.win = new electron_1.BrowserWindow({
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
                preload: (0, paths_1.preloadPath)(),
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
        void this.win.loadFile((0, paths_1.overlayHtmlPath)()).catch((error) => {
            this.logger.error('system', 'overlay failed to load', { error: String(error) });
            this.markDead('overlay failed to load');
        });
        this.ackListener = (event) => {
            if (event.sender.id !== this.win.webContents.id)
                return;
            this.lastAck = Date.now();
            if (this.dead) {
                this.dead = false;
                this.logger.info('heartbeat', 'ghost overlay heartbeat recovered');
                this.onAlive?.();
            }
        };
        this.readyListener = (event) => {
            if (event.sender.id !== this.win.webContents.id)
                return;
            this.ready = true;
            this.lastAck = Date.now();
        };
    }
    /** Start the heartbeat (spec section 10: halt when an overlay stops answering). */
    start() {
        electron_1.ipcMain.on(types_1.IPC.ghostHeartbeatAck, this.ackListener);
        electron_1.ipcMain.on(types_1.IPC.ghostReady, this.readyListener);
        this.lastAck = Date.now();
        this.timer = setInterval(() => {
            if (this.destroyed || this.win.isDestroyed()) {
                this.markDead('overlay window destroyed');
                return;
            }
            try {
                this.win.webContents.send(types_1.IPC.ghostHeartbeat, Date.now());
            }
            catch (error) {
                this.markDead(`overlay send failed: ${String(error)}`);
                return;
            }
            if (Date.now() - this.lastAck > types_1.HEARTBEAT_TIMEOUT_MS) {
                this.markDead('overlay heartbeat timed out');
            }
        }, types_1.HEARTBEAT_INTERVAL_MS);
        this.logger.info('heartbeat', 'ghost overlay heartbeat started', {
            intervalMs: types_1.HEARTBEAT_INTERVAL_MS,
            timeoutMs: types_1.HEARTBEAT_TIMEOUT_MS,
        });
    }
    markDead(reason) {
        if (this.dead)
            return;
        this.dead = true;
        this.logger.error('heartbeat', `ghost overlay lost: ${reason}`, { reason });
        this.onDead?.();
    }
    get alive() {
        return !this.dead && !this.destroyed && !this.win.isDestroyed();
    }
    get isReady() {
        return this.ready;
    }
    get window() {
        return this.win;
    }
    /** Send one ghost command to the overlay renderer. */
    send(command) {
        if (this.destroyed || this.win.isDestroyed() || !this.ready)
            return;
        try {
            this.win.webContents.send(types_1.IPC.ghostCommand, command);
        }
        catch (error) {
            this.markDead(`overlay send failed: ${String(error)}`);
        }
    }
    /** Move the ghost cursor to an absolute screen DIP position. */
    move(x, y, durationMs, hint) {
        const local = (0, coordinates_1.screenToOverlayLocal)(electron_1.screen.getPrimaryDisplay().bounds, { x, y });
        this.send({ kind: 'move', x: local.x, y: local.y, durationMs, hint });
    }
    pulse() {
        this.send({ kind: 'pulse' });
    }
    ripple() {
        this.send({ kind: 'ripple' });
    }
    hint(text) {
        this.send({ kind: 'hint', text });
    }
    thinking(on) {
        this.send({ kind: 'thinking', on });
    }
    hide() {
        this.send({ kind: 'hide' });
    }
    /** Target is off screen: point toward it from the display edge and hint. */
    offscreen(x, y, hint) {
        const local = (0, coordinates_1.screenToOverlayLocal)(electron_1.screen.getPrimaryDisplay().bounds, { x, y });
        this.send({ kind: 'offscreen', x: local.x, y: local.y, hint });
    }
    /** Follow a display change (v1 keeps the primary display). */
    resizeToPrimaryDisplay() {
        if (this.destroyed || this.win.isDestroyed())
            return;
        this.win.setBounds(electron_1.screen.getPrimaryDisplay().bounds);
    }
    destroy() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        electron_1.ipcMain.removeListener(types_1.IPC.ghostHeartbeatAck, this.ackListener);
        electron_1.ipcMain.removeListener(types_1.IPC.ghostReady, this.readyListener);
        if (!this.destroyed && !this.win.isDestroyed())
            this.win.destroy();
        this.destroyed = true;
    }
}
exports.OverlayWindow = OverlayWindow;
//# sourceMappingURL=overlayWindow.js.map