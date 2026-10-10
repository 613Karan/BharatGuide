/** Overlay preload: receives OverlayCommand only, answers the heartbeat. */
import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayCommand } from '../shared/ipc';

const CH = { command: 'overlay:command', ping: 'overlay:ping', pong: 'overlay:pong' };

const api = {
  onCommand(handler: (command: OverlayCommand) => void): void {
    ipcRenderer.on(CH.command, (_e, command: OverlayCommand) => handler(command));
  },
  /** Answer every heartbeat so main knows the ghost is still drawable. */
  startHeartbeat(): void {
    ipcRenderer.on(CH.ping, () => ipcRenderer.send(CH.pong));
    ipcRenderer.send(CH.pong);
  },
};

export type GhostApi = typeof api;
contextBridge.exposeInMainWorld('ghost', api);
