import { app, screen } from 'electron';
import * as path from 'node:path';
import { AgentCore } from './agent/core';
import { OllamaPlanner } from './agent/ollamaPlanner';
import type { Planner } from './agent/planner';
import { BrowserBridge } from './browser/bridge';
import { launchChrome } from './browser/chromeLauncher';
import type { LaunchedChrome } from './browser/chromeLauncher';
import { Logger } from './logger';
import { runSmokeTest } from './smoke';
import { DialogWindow } from './ui/dialogWindow';
import { OverlayWindow } from './ui/overlayWindow';

/**
 * Electron main entry (spec sections 3, 9 and 10).
 *
 * Startup order: logger -> Chrome (own profile, CDP port) -> bridge -> ghost
 * overlay -> dialog panel -> agent core. Shutdown walks the same list backwards,
 * so nothing keeps running after the app quits: no stray Chrome process, no
 * hidden overlay, no live CDP session.
 *
 * Command line:
 *   --smoke                 run the scripted smoke test and exit with 0/1
 *   --chrome-path=<path>    use a specific Chromium binary
 *   --start-url=<url>       page Chrome opens (default https://www.google.com/)
 *   --hotkey=<accelerator>  dialog hotkey (default Control+Shift+G)
 *   --planner=ollama        propose steps with a local Ollama model
 *   --ollama-model=<name>   model name for the Ollama planner
 */

interface CliOptions {
  smoke: boolean;
  chromePath: string | null;
  startUrl: string | null;
  hotkey: string | null;
  useOllama: boolean;
  ollamaModel: string | null;
}

function flagValue(argv: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((item) => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function parseArgs(argv: string[]): CliOptions {
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

let logger: Logger | null = null;
let chrome: LaunchedChrome | null = null;
let bridge: BrowserBridge | null = null;
let overlay: OverlayWindow | null = null;
let dialog: DialogWindow | null = null;
let agent: AgentCore | null = null;
let shuttingDown = false;

/** Tear everything down in reverse order of creation, then leave the process. */
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger?.info('system', 'shutdown started', { reason });

  try {
    await agent?.shutdown();
  } catch (error) {
    logger?.warn('system', 'agent shutdown failed', { error: String(error) });
  }
  try {
    dialog?.destroy();
  } catch (error) {
    logger?.warn('system', 'dialog shutdown failed', { error: String(error) });
  }
  try {
    overlay?.destroy();
  } catch (error) {
    logger?.warn('system', 'overlay shutdown failed', { error: String(error) });
  }
  try {
    await bridge?.disconnect();
  } catch (error) {
    logger?.warn('system', 'bridge disconnect failed', { error: String(error) });
  }
  try {
    await chrome?.close();
  } catch (error) {
    logger?.warn('system', 'chrome close failed', { error: String(error) });
  }

  logger?.info('system', 'shutdown finished', { reason, exitCode });
  app.exit(exitCode);
}

/** Start Chrome, connect the bridge, build the UI and start the agent. */
async function boot(): Promise<void> {
  const logDir = path.join(app.getPath('userData'), 'logs');
  logger = new Logger({ dir: logDir, echoToConsole: true });
  logger.info('system', 'ghost cursor starting', {
    version: app.getVersion(),
    platform: process.platform,
    smoke: cli.smoke,
    planner: cli.useOllama ? 'ollama' : 'heuristic',
    logFile: logger.filePath,
  });

  const workArea = screen.getPrimaryDisplay().workArea;
  // Chrome takes the left part of the screen; the dialog panel lives top-right.
  chrome = await launchChrome({
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

  bridge = new BrowserBridge({
    browserWSEndpoint: chrome.webSocketDebuggerUrl,
    log: (message, data) => logger?.info('system', message, data),
  });
  await bridge.connect();

  overlay = new OverlayWindow({
    logger,
    // Never act without a visible ghost cursor (spec section 10).
    onDead: () => agent?.handleOverlayLost(),
    onAlive: () => logger?.info('heartbeat', 'ghost overlay is answering again'),
  });
  overlay.start();

  const dialogWindow = new DialogWindow({
    logger,
    hotkey: cli.hotkey ?? 'Control+Shift+G',
    onSubmit: (text) => {
      void agent?.handleUserMessage(text).catch((error: unknown) => {
        logger?.error('system', 'message handling failed', { error: String(error) });
      });
    },
    onEsc: () => agent?.handleEsc('dialog Escape'),
    onHide: () => logger?.info('system', 'dialog panel hidden'),
  });
  dialog = dialogWindow;
  dialogWindow.start();

  const planner: Planner | undefined = cli.useOllama
    ? new OllamaPlanner({
        model: cli.ollamaModel ?? undefined,
        log: (message, data) => logger?.info('plan', message, data),
      })
    : undefined;

  agent = new AgentCore({ bridge, overlay, dialog: dialogWindow, logger, planner });
  await agent.start();
  dialogWindow.open();

  logger.info('system', 'ghost cursor ready', {
    hotkey: dialogWindow.currentHotkey,
    overlayReady: overlay.isReady,
    dialogAlive: dialogWindow.alive,
    state: agent.state,
  });

  if (cli.smoke) {
    const passed = await runSmokeTest({
      agent,
      bridge,
      overlay,
      dialog: dialogWindow,
      logger,
    });
    await shutdown(passed ? 'smoke test passed' : 'smoke test failed', passed ? 0 : 1);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => dialog?.toggle());

  void app
    .whenReady()
    .then(boot)
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Ghost Cursor failed to start:', error);
      void shutdown(`startup failed: ${String(error)}`, 1);
    });
}

app.on('window-all-closed', () => {
  void shutdown('all windows closed', 0);
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
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
