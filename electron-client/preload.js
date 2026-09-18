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
} else {
  // The remote Wire server's own pages (loaded via loadURL in main.js).
  // A narrow, origin-scoped API used only to cache the E2EE identity's
  // derived unlock key (never the account password, never the raw
  // private key - see the site's identity.js) so "Remember me on this
  // device" can skip the password prompt on the next launch.
  //
  // Backed by Electron's OS-level safeStorage in the main process.
  // main.js independently re-derives the caller's real origin from
  // its own WebContents on every call, so this page can only ever
  // read/write the cache entry for the server it is actually loaded
  // from right now, regardless of what origin string it passes in.
  contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,

    storeIdentityUnlockKey: (origin, userId, unlockKey) =>
      ipcRenderer.invoke('identity:store-unlock-key', origin, userId, unlockKey),

    getIdentityUnlockKey: (origin, userId) =>
      ipcRenderer.invoke('identity:get-unlock-key', origin, userId),

    clearIdentityUnlockKey: (origin, userId) =>
      ipcRenderer.invoke('identity:clear-unlock-key', origin, userId),

    // Local device rendering preference — see main.js. Not per-origin or
    // per-account, so (unlike the identity-key methods above) there's no
    // origin argument to verify.
    getHardwareAcceleration: () =>
      ipcRenderer.invoke('app:hardware-acceleration:get'),

    setHardwareAcceleration: (enabled) =>
      ipcRenderer.invoke('app:hardware-acceleration:set', enabled),

    relaunchApp: () =>
      ipcRenderer.invoke('app:relaunch'),

    // Sends the user back to the existing "Connect to Server" screen
    // (renderer/connect.html) so they can change servers — the Login
    // screen only shows the current one and delegates the actual
    // change to that existing flow.
    showConnectScreen: () =>
      ipcRenderer.invoke('server:show-connect-screen'),
  });
}
