/** Chat preload: may only send ChatCommand and receive ChatEvent (spec 7.3). */
import { contextBridge, ipcRenderer } from 'electron';
import type { ChatCommand, ChatEvent } from '../shared/ipc';

// Channel names inlined: sandboxed preloads should stay dependency-free.
const CH = { command: 'chat:command', event: 'chat:event', ready: 'chat:ready', focus: 'chat:focus-input' };

const api = {
  send(command: ChatCommand): void {
    ipcRenderer.send(CH.command, command);
  },
  onEvent(handler: (event: ChatEvent) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: ChatEvent): void => handler(payload);
    ipcRenderer.on(CH.event, listener);
    return () => ipcRenderer.removeListener(CH.event, listener);
  },
  onFocusInput(handler: () => void): () => void {
    const listener = (): void => handler();
    ipcRenderer.on(CH.focus, listener);
    return () => ipcRenderer.removeListener(CH.focus, listener);
  },
  ready(): void {
    ipcRenderer.send(CH.ready);
  },
};

export type ChatApi = typeof api;
contextBridge.exposeInMainWorld('chat', api);
