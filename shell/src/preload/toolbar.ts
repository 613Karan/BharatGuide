/** Toolbar preload: tab/address-bar commands, toolbar state, ghost-target rects. */
import { contextBridge, ipcRenderer } from 'electron';
import type { GhostRect, ToolbarCommand, ToolbarFx, ToolbarState } from '../shared/ipc';

const CH = { command: 'toolbar:command', state: 'toolbar:state', fx: 'toolbar:fx', rects: 'toolbar:rects', ready: 'toolbar:ready' };

function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  send(command: ToolbarCommand): void {
    ipcRenderer.send(CH.command, command);
  },
  reportRects(rects: GhostRect[]): void {
    ipcRenderer.send(CH.rects, rects);
  },
  onState: (handler: (state: ToolbarState) => void) => on(CH.state, handler),
  onFx: (handler: (fx: ToolbarFx) => void) => on(CH.fx, handler),
  ready(): void {
    ipcRenderer.send(CH.ready);
  },
};

export type ToolbarApi = typeof api;
// `window.toolbar` is a built-in DOM property (BarProp), so use another name.
contextBridge.exposeInMainWorld('browserBar', api);
