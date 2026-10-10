/**
 * Shared preload for both transparent windows (ghost overlay + dialog panel).
 *
 * contextIsolation is on and nodeIntegration is off, so the renderers only see
 * the small `window.ghost` API below: no Node, no filesystem, no CDP. Channel
 * names mirror src/shared/types.ts (IPC), which is the single source of truth.
 */
const { contextBridge, ipcRenderer } = require('electron');

const IPC = {
  dialogSubmit: 'gc:dialog:submit',
  dialogHide: 'gc:dialog:hide',
  dialogEsc: 'gc:dialog:esc',
  dialogReady: 'gc:dialog:ready',
  dialogMessage: 'gc:dialog:message',
  dialogStatus: 'gc:dialog:status',
  dialogFocusInput: 'gc:dialog:focus-input',
  ghostCommand: 'gc:ghost:command',
  ghostHeartbeat: 'gc:ghost:heartbeat',
  ghostReady: 'gc:ghost:ready',
  ghostHeartbeatAck: 'gc:ghost:heartbeat-ack',
};

/** Listen on one channel and return a disposer. Payloads are plain data. */
function subscribe(channel, handler) {
  const listener = (_event, payload) => {
    try {
      handler(payload);
    } catch (error) {
      console.error(`renderer handler failed on ${channel}:`, error);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('ghost', {
  // ---- ghost overlay renderer -------------------------------------------
  onGhostCommand: (handler) => subscribe(IPC.ghostCommand, handler),
  onGhostHeartbeat: (handler) => subscribe(IPC.ghostHeartbeat, handler),
  ghostReady: () => ipcRenderer.send(IPC.ghostReady),
  ghostAck: () => ipcRenderer.send(IPC.ghostHeartbeatAck),

  // ---- dialog renderer ---------------------------------------------------
  onDialogMessage: (handler) => subscribe(IPC.dialogMessage, handler),
  onDialogStatus: (handler) => subscribe(IPC.dialogStatus, handler),
  onDialogFocusInput: (handler) => subscribe(IPC.dialogFocusInput, handler),
  dialogReady: () => ipcRenderer.send(IPC.dialogReady),
  // The dialog answers the heartbeat on the same ack channel; main filters by
  // webContents id, so each window keeps its own liveness.
  dialogAck: () => ipcRenderer.send(IPC.ghostHeartbeatAck),
  dialogSubmit: (text) => ipcRenderer.send(IPC.dialogSubmit, { text: String(text ?? '') }),
  dialogEsc: () => ipcRenderer.send(IPC.dialogEsc),
  dialogHide: () => ipcRenderer.send(IPC.dialogHide),
});
