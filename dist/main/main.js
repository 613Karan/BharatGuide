"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("node:path"));
const core_1 = require("./agent/core");
const ollamaPlanner_1 = require("./agent/ollamaPlanner");
const bridge_1 = require("./browser/bridge");
const chromeLauncher_1 = require("./browser/chromeLauncher");
const logger_1 = require("./logger");
const smoke_1 = require("./smoke");
const dialogWindow_1 = require("./ui/dialogWindow");
const overlayWindow_1 = require("./ui/overlayWindow");
function flagValue(argv, name) {
    const prefix = `--${name}=`;
    const hit = argv.find((item) => item.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
}
function parseArgs(argv) {
    return {
        smoke: argv.includes('--smoke'),
        chromePath: flagValue(argv, 'chrome-path'),
        startUrl: flagValue(argv, 'start-url'),
        hotkey: flagValue(argv, 'hotkey'),
        useOllama: flagValue(argv, 'planner') === 'ollama' || argv.includes('--ollama'),
        ollamaModel: flagValue(argv, 'ollama-model'),
    };
}
const cli = parseArgs(process.argv.slice(2));
let logger = null;
let chrome = null;
let bridge = null;
let overlay = null;
let dialog = null;
let agent = null;
let shuttingDown = false;
/** Tear everything down in reverse order of creation, then leave the process. */
async function shutdown(reason, exitCode = 0) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    logger?.info('system', 'shutdown started', { reason });
    try {
        await agent?.shutdown();
    }
    catch (error) {
        logger?.warn('system', 'agent shutdown failed', { error: String(error) });
    }
    try {
        dialog?.destroy();
    }
    catch (error) {
        logger?.warn('system', 'dialog shutdown failed', { error: String(error) });
    }
    try {
        overlay?.destroy();
    }
    catch (error) {
        logger?.warn('system', 'overlay shutdown failed', { error: String(error) });
    }
    try {
        await bridge?.disconnect();
    }
    catch (error) {
        logger?.warn('system', 'bridge disconnect failed', { error: String(error) });
    }
    try {
        await chrome?.close();
    }
    catch (error) {
        logger?.warn('system', 'chrome close failed', { error: String(error) });
    }
    logger?.info('system', 'shutdown finished', { reason, exitCode });
    electron_1.app.exit(exitCode);
}
/** Start Chrome, connect the bridge, build the UI and start the agent. */
async function boot() {
    const logDir = path.join(electron_1.app.getPath('userData'), 'logs');
    logger = new logger_1.Logger({ dir: logDir, echoToConsole: true });
    logger.info('system', 'ghost cursor starting', {
        version: electron_1.app.getVersion(),
        platform: process.platform,
        smoke: cli.smoke,
        planner: cli.useOllama ? 'ollama' : 'heuristic',
        logFile: logger.filePath,
    });
    const workArea = electron_1.screen.getPrimaryDisplay().workArea;
    // Chrome takes the left part of the screen; the dialog panel lives top-right.
    chrome = await (0, chromeLauncher_1.launchChrome)({
        chromePath: cli.chromePath ?? undefined,
        startUrl: cli.startUrl ?? 'https://www.google.com/',
        windowSize: {
            width: Math.max(760, workArea.width - 460),
            height: Math.max(520, workArea.height - 80),
        },
        windowPosition: { x: workArea.x + 16, y: workArea.y + 24 },
    });
    chrome.process.once('exit', () => {
        void shutdown('Chrome exited', 0);
    });
    logger.info('system', 'Chrome launched with CDP', {
        port: chrome.port,
        browser: chrome.browserVersion,
        profile: chrome.userDataDir,
        chromePath: chrome.chromePath,
    });
    bridge = new bridge_1.BrowserBridge({
        browserWSEndpoint: chrome.webSocketDebuggerUrl,
        log: (message, data) => logger?.info('system', message, data),
    });
    await bridge.connect();
    overlay = new overlayWindow_1.OverlayWindow({
        logger,
        // Never act without a visible ghost cursor (spec section 10).
        onDead: () => agent?.handleOverlayLost(),
        onAlive: () => logger?.info('heartbeat', 'ghost overlay is answering again'),
    });
    overlay.start();
    const dialogWindow = new dialogWindow_1.DialogWindow({
        logger,
        hotkey: cli.hotkey ?? 'Control+Shift+G',
        onSubmit: (text) => {
            void agent?.handleUserMessage(text).catch((error) => {
                logger?.error('system', 'message handling failed', { error: String(error) });
            });
        },
        onEsc: () => agent?.handleEsc('dialog Escape'),
        onHide: () => logger?.info('system', 'dialog panel hidden'),
    });
    dialog = dialogWindow;
    dialogWindow.start();
    const planner = cli.useOllama
        ? new ollamaPlanner_1.OllamaPlanner({
            model: cli.ollamaModel ?? undefined,
            log: (message, data) => logger?.info('plan', message, data),
        })
        : undefined;
    agent = new core_1.AgentCore({ bridge, overlay, dialog: dialogWindow, logger, planner });
    await agent.start();
    dialogWindow.open();
    logger.info('system', 'ghost cursor ready', {
        hotkey: dialogWindow.currentHotkey,
        overlayReady: overlay.isReady,
        dialogAlive: dialogWindow.alive,
        state: agent.state,
    });
    if (cli.smoke) {
        const passed = await (0, smoke_1.runSmokeTest)({
            agent,
            bridge,
            overlay,
            dialog: dialogWindow,
            logger,
        });
        await shutdown(passed ? 'smoke test passed' : 'smoke test failed', passed ? 0 : 1);
    }
}
const gotLock = electron_1.app.requestSingleInstanceLock();
if (!gotLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => dialog?.toggle());
    void electron_1.app
        .whenReady()
        .then(boot)
        .catch((error) => {
        // eslint-disable-next-line no-console
        console.error('Ghost Cursor failed to start:', error);
        void shutdown(`startup failed: ${String(error)}`, 1);
    });
}
electron_1.app.on('window-all-closed', () => {
    void shutdown('all windows closed', 0);
});
electron_1.app.on('before-quit', (event) => {
    if (shuttingDown)
        return;
    event.preventDefault();
    void shutdown('before-quit', 0);
});
process.on('uncaughtException', (error) => {
    logger?.error('system', 'uncaught exception', { error: String(error) });
    void shutdown('uncaught exception', 1);
});
process.on('unhandledRejection', (reason) => {
    logger?.error('system', 'unhandled rejection', { reason: String(reason) });
});
//# sourceMappingURL=main.js.map