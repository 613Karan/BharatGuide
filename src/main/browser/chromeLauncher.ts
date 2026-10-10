import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Chrome launcher (spec section 3).
 *
 * The app starts Chrome itself with `--remote-debugging-port` and its own
 * `--user-data-dir`, then talks to it over CDP. A visible window is required: v1
 * supports windowed and borderless Chrome only, never exclusive fullscreen.
 */

export interface ChromeLaunchOptions {
  port?: number;
  userDataDir?: string;
  startUrl?: string;
  chromePath?: string;
  windowSize?: { width: number; height: number };
  windowPosition?: { x: number; y: number };
  extraArgs?: string[];
  /** Milliseconds to wait for the debug endpoint. */
  timeoutMs?: number;
}

export interface LaunchedChrome {
  process: ChildProcess;
  port: number;
  userDataDir: string;
  chromePath: string;
  webSocketDebuggerUrl: string;
  browserVersion: string;
  close(): Promise<void>;
}

export interface DebuggerVersion {
  Browser: string;
  webSocketDebuggerUrl: string;
}

const WINDOWS_CANDIDATES = [
  process.env.ProgramFiles
    ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : null,
  process.env['ProgramFiles(x86)']
    ? path.join(
        process.env['ProgramFiles(x86)'] as string,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      )
    : null,
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : null,
  // Edge is Chromium and speaks the same CDP; used only if Chrome is missing.
  process.env['ProgramFiles(x86)']
    ? path.join(
        process.env['ProgramFiles(x86)'] as string,
        'Microsoft',
        'Edge',
        'Application',
        'msedge.exe',
      )
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
export function findChromePath(): string | null {
  const platform = process.platform;
  if (platform === 'win32') {
    for (const candidate of WINDOWS_CANDIDATES) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  const candidates = platform === 'darwin' ? MAC_CANDIDATES : LINUX_CANDIDATES;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Ask the OS for an unused TCP port. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('could not allocate a port')));
      }
    });
  });
}

function getJson(url: string, timeoutMs: number): Promise<DebuggerVersion> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as DebuggerVersion);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

/** Poll /json/version until Chrome answers. */
export async function waitForDebugger(
  port: number,
  timeoutMs = 30_000,
): Promise<DebuggerVersion> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const version = await getJson(`http://127.0.0.1:${port}/json/version`, 2_000);
      if (version.webSocketDebuggerUrl) return version;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Chrome debug endpoint did not open on port ${port} within ${timeoutMs} ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ''),
  );
}

/** Command line used to start Chrome. No OS-level input is ever involved. */
export function buildChromeArgs(options: {
  port: number;
  userDataDir: string;
  startUrl: string;
  windowSize?: { width: number; height: number };
  windowPosition?: { x: number; y: number };
  extraArgs?: string[];
}): string[] {
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
  if (options.extraArgs) args.push(...options.extraArgs);
  args.push('--new-window', options.startUrl);
  return args;
}

/** Launch Chrome and wait until CDP is reachable. */
export async function launchChrome(
  options: ChromeLaunchOptions = {},
): Promise<LaunchedChrome> {
  const chromePath = options.chromePath ?? findChromePath();
  if (!chromePath) {
    throw new Error(
      'No Chromium-based browser found. Install Google Chrome, or pass --chrome-path.',
    );
  }
  const port = options.port ?? (await getFreePort());
  const userDataDir =
    options.userDataDir ?? path.join(os.tmpdir(), 'ghost-cursor-chrome-profile');
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

  const child = spawn(chromePath, args, {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  child.unref();

  const version = await waitForDebugger(port, options.timeoutMs ?? 30_000);

  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === 'win32') {
      // Kill the whole tree: Chrome spawns child processes per tab and per GPU.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    } else {
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

