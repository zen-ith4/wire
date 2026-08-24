'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only expose the connect-screen API when we're actually on the local
// connect.html page (file:// protocol). If this preload script ever
// runs alongside the remote website (it doesn't, by design — see
// main.js's per-window preload wiring — but this is a defense-in-depth
// check), the remote page gets no privileged API at all.
if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('wireClient', {
    getSavedServer: () => ipcRenderer.invoke('server:get-saved'),
    forgetServer: () => ipcRenderer.invoke('server:forget'),
    connect: (address) => ipcRenderer.invoke('server:connect', address),
  });
}
