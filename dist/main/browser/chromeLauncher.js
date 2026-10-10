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
exports.findChromePath = findChromePath;
exports.getFreePort = getFreePort;
exports.waitForDebugger = waitForDebugger;
exports.buildChromeArgs = buildChromeArgs;
exports.launchChrome = launchChrome;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const http = __importStar(require("node:http"));
const net = __importStar(require("node:net"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const WINDOWS_CANDIDATES = [
    process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
    process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
    process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
    // Edge is Chromium and speaks the same CDP; used only if Chrome is missing.
    process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : null,
];
const MAC_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
];
const LINUX_CANDIDATES = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
];
/** Locate a Chromium-based browser on this machine. */
function findChromePath() {
    const platform = process.platform;
    if (platform === 'win32') {
        for (const candidate of WINDOWS_CANDIDATES) {
            if (candidate && fs.existsSync(candidate))
                return candidate;
        }
        return null;
    }
    const candidates = platform === 'darwin' ? MAC_CANDIDATES : LINUX_CANDIDATES;
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
/** Ask the OS for an unused TCP port. */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (typeof address === 'object' && address) {
                const { port } = address;
                server.close(() => resolve(port));
            }
            else {
                server.close(() => reject(new Error('could not allocate a port')));
            }
        });
    });
}
function getJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { timeout: timeoutMs }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', reject);
    });
}
/** Poll /json/version until Chrome answers. */
async function waitForDebugger(port, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const version = await getJson(`http://127.0.0.1:${port}/json/version`, 2_000);
            if (version.webSocketDebuggerUrl)
                return version;
        }
        catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Chrome debug endpoint did not open on port ${port} within ${timeoutMs} ms` +
        (lastError ? ` (last error: ${String(lastError)})` : ''));
}
/** Command line used to start Chrome. No OS-level input is ever involved. */
function buildChromeArgs(options) {
    const args = [
        `--remote-debugging-port=${options.port}`,
        `--user-data-dir=${options.userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        // The ghost overlay covers the whole screen, so Windows marks the Chrome window
        // as occluded: the tab reports visibilityState=hidden and then silently drops
        // synthetic key events (typing would never reach the page). These flags keep the
        // page live and accepting CDP input even while the overlay is on top.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI,InfiniteSessionRestore,CalculateNativeWinOcclusion',
        '--no-service-autorun',
    ];
    if (options.windowSize) {
        args.push(`--window-size=${options.windowSize.width},${options.windowSize.height}`);
    }
    if (options.windowPosition) {
        args.push(`--window-position=${options.windowPosition.x},${options.windowPosition.y}`);
    }
    if (options.extraArgs)
        args.push(...options.extraArgs);
    args.push('--new-window', options.startUrl);
    return args;
}
/** Launch Chrome and wait until CDP is reachable. */
async function launchChrome(options = {}) {
    const chromePath = options.chromePath ?? findChromePath();
    if (!chromePath) {
        throw new Error('No Chromium-based browser found. Install Google Chrome, or pass --chrome-path.');
    }
    const port = options.port ?? (await getFreePort());
    const userDataDir = options.userDataDir ?? path.join(os.tmpdir(), 'ghost-cursor-chrome-profile');
    fs.mkdirSync(userDataDir, { recursive: true });
    const startUrl = options.startUrl ?? 'https://www.google.com/';
    const args = buildChromeArgs({
        port,
        userDataDir,
        startUrl,
        windowSize: options.windowSize ?? { width: 1280, height: 860 },
        windowPosition: options.windowPosition,
        extraArgs: options.extraArgs,
    });
    const child = (0, node_child_process_1.spawn)(chromePath, args, {
        detached: process.platform !== 'win32',
        stdio: 'ignore',
    });
    child.unref();
    const version = await waitForDebugger(port, options.timeoutMs ?? 30_000);
    const close = async () => {
        if (child.exitCode !== null || child.pid === undefined)
            return;
        if (process.platform === 'win32') {
            // Kill the whole tree: Chrome spawns child processes per tab and per GPU.
            (0, node_child_process_1.spawn)('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
        }
        else {
            child.kill('SIGTERM');
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
    };
    return {
        process: child,
        port,
        userDataDir,
        chromePath,
        webSocketDebuggerUrl: version.webSocketDebuggerUrl,
        browserVersion: version.Browser,
        close,
    };
}
//# sourceMappingURL=chromeLauncher.js.map