'use strict';

/**
 * Preload runs in an isolated world with access to Node/Electron
 * APIs, but the renderer (Wire's existing web app, and our own local
 * welcome screen) only ever sees the `window.electronAPI` object
 * built with contextBridge below. No `require`, `ipcRenderer`, `fs`,
 * `process`, or `child_process` is ever attached to `window` directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_STATUS_CHANNELS = ['server:connection-status'];

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // ---- Server configuration ----
  getServerUrl: () => ipcRenderer.invoke('server:get-current'),
  testServerUrl: (url) => ipcRenderer.invoke('server:test', String(url || '')),
  connectToServer: (url, options) =>
    ipcRenderer.invoke('server:connect', String(url || ''), {
      remember: Boolean(options && options.remember !== false),
    }),
  forgetServer: () => ipcRenderer.invoke('server:forget'),

  // ---- Certificate trust (self-signed servers) ----
  getCertificateInfo: (url) => ipcRenderer.invoke('server:get-certificate-info', String(url || '')),
  trustCertificate: (url, fingerprint256) =>
    ipcRenderer.invoke('server:trust-certificate', String(url || ''), String(fingerprint256 || '')),

  // ---- App info / lifecycle ----
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  reload: () => ipcRenderer.invoke('app:reload'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', String(url || '')),

  // ---- E2EE identity auto-unlock material ----
  // Only ever carries the PBKDF2-derived unlock key produced by
  // public/js/crypto/identity.js - never a password, never a
  // private key. See electron/main/secure-store.js.
  storeIdentityUnlockKey: (origin, userId, unlockKey) =>
    ipcRenderer.invoke('identity:store-unlock-key', String(origin || ''), Number(userId), String(unlockKey || '')),
  getIdentityUnlockKey: (origin, userId) =>
    ipcRenderer.invoke('identity:get-unlock-key', String(origin || ''), Number(userId)),
  clearIdentityUnlockKey: (origin, userId) =>
    ipcRenderer.invoke('identity:clear-unlock-key', String(origin || ''), Number(userId)),

  // ---- Push notifications from main (e.g. "server became unreachable") ----
  onConnectionStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};

    const channel = 'server:connection-status';
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
